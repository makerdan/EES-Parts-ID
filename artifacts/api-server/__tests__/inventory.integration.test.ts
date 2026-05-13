/**
 * Integration tests for POST /api/inventory/search and
 * POST /api/inventory/upsert-batch.
 *
 * Uses a real PostgreSQL database (DATABASE_URL env var).
 * OpenAI integration is mocked to avoid requiring a live API key.
 */

// ── Mock the OpenAI integration BEFORE app is imported ───────────────────────
// Both the main export and the batch sub-path are hoisted here so that modules
// that throw at initialisation (client.ts checks env vars) never execute.
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: jest.fn() } },
    audio: { transcriptions: { create: jest.fn() } },
  },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "../src/routes/admin";
import {
  seedFixtures,
  cleanupFixtures,
  closePool,
  STANDARD_FIXTURES,
} from "./helpers/testDb";

// ── Test configuration ────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-integration-test-secret";
let adminToken: string;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanupFixtures();
  await seedFixtures(STANDARD_FIXTURES);
}, 30_000);

afterAll(async () => {
  await cleanupFixtures();
  await closePool();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/search", () => {
  it("returns 200 with matching results for a seeded catalog number", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-BR120" })
      .expect(200);

    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);

    const match = res.body.results.find(
      (r: { item: { catalog: string } }) => r.item.catalog === "JEST-ITG-BR120",
    );
    expect(match).toBeDefined();
    expect(match.item.vendor).toBe("EATON");
  });

  it("returns 200 with an empty results array for a keyword that matches nothing", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "ZZZNOMATCH-XYZ-99999-UNIQUE" })
      .expect(200);

    expect(res.body).toHaveProperty("results");
    expect(res.body.results).toEqual([]);
  });

  it("returns 200 with totalMatches and belowThreshold fields in the response", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-BR120" })
      .expect(200);

    expect(res.body).toHaveProperty("totalMatches");
    expect(res.body).toHaveProperty("belowThreshold");
    expect(typeof res.body.totalMatches).toBe("number");
    expect(typeof res.body.belowThreshold).toBe("number");
  });

  it("returns 200 with empty results when confidenceThreshold is set to 100", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-BR120", confidenceThreshold: 100 })
      .expect(200);

    // Even exact matches score ≤ 1.0 (= 100%), so threshold = 100 filters them out
    // unless they score exactly 1.0 (exact catalog match).
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it("returns 200 with empty results array when no search text is provided", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({})
      .expect(200);

    expect(res.body).toHaveProperty("results");
    expect(res.body.results).toEqual([]);
  });

  it("returns the dimensionCounts object in the response", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG" })
      .expect(200);

    expect(res.body).toHaveProperty("dimensionCounts");
    expect(typeof res.body.dimensionCounts).toBe("object");
  });

  it("applies chip filters in SQL: a Red color filter excludes the Ivory seeded item", async () => {
    // Without the SQL push-down (the bug), chip filters were applied only
    // after the LIMIT 200 candidate cut. With the fix in place we can prove
    // the SQL clause is doing the work by querying for our seeded ivory
    // receptacle with colorChip="Red" — we should get zero matches even
    // though the keyword query alone would surface it.
    const ivoryOnly = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-HBL5262I" })
      .expect(200);
    expect(
      ivoryOnly.body.results.some(
        (r: { item: { catalog: string } }) =>
          r.item.catalog === "JEST-ITG-HBL5262I",
      ),
    ).toBe(true);

    const filteredRed = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-HBL5262I", colorChip: "Red" })
      .expect(200);
    expect(
      filteredRed.body.results.some(
        (r: { item: { catalog: string } }) =>
          r.item.catalog === "JEST-ITG-HBL5262I",
      ),
    ).toBe(false);
  });

  it("chip filter with a punctuation-leading token (#14 wireGauge) matches via SQL", async () => {
    // Real wireGauge chip values include "#14", "#12" etc. The first
    // pushdown implementation used Postgres `\m...\M` boundaries, which
    // silently never match tokens whose first/last char is non-word — a
    // regression that would break exactly these chip values. Seed a needle
    // whose ai_keywords contain "#14" and confirm the SQL pushdown finds it,
    // then confirm a non-matching gauge filter excludes it.
    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    // Opaque catalog so trgm_sim dominates and the needle is guaranteed
    // to be inside the LIMIT 200 candidate window regardless of the real
    // 7k-row corpus surrounding it.
    const NEEDLE = "JESTPUNCT9Q1";
    await db.delete(inventoryTable).where(eq(inventoryTable.catalog, NEEDLE));
    await db.insert(inventoryTable).values({
      vendor: "JEST-PUNCT-VENDOR",
      catalog: NEEDLE,
      description: "JESTPUNCT9Q1 wire fixture",
      binLocations: [],
      aiKeywords: ["#14"],
    });

    try {
      const res = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: NEEDLE, wireGauge: "#14" })
        .expect(200);
      expect(
        res.body.results.some(
          (r: { item: { catalog: string } }) => r.item.catalog === NEEDLE,
        ),
      ).toBe(true);

      // Negative control: same query with a non-matching wireGauge filter
      // should exclude the needle.
      const negative = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: NEEDLE, wireGauge: "#12" })
        .expect(200);
      expect(
        negative.body.results.some(
          (r: { item: { catalog: string } }) => r.item.catalog === NEEDLE,
        ),
      ).toBe(false);
    } finally {
      await db.delete(inventoryTable).where(eq(inventoryTable.catalog, NEEDLE));
    }
  });

  it("chip filter with a punctuation-bordered token (sizeChip 1/2\") matches via SQL", async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const NEEDLE = "JESTHALF9Q2";
    await db.delete(inventoryTable).where(eq(inventoryTable.catalog, NEEDLE));
    await db.insert(inventoryTable).values({
      vendor: "JEST-HALF-VENDOR",
      catalog: NEEDLE,
      description: "JESTHALF9Q2 conduit fitting",
      binLocations: [],
      aiKeywords: ['1/2"'],
    });

    try {
      const res = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: NEEDLE, sizeChip: '1/2"' })
        .expect(200);
      expect(
        res.body.results.some(
          (r: { item: { catalog: string } }) => r.item.catalog === NEEDLE,
        ),
      ).toBe(true);
    } finally {
      await db.delete(inventoryTable).where(eq(inventoryTable.catalog, NEEDLE));
    }
  });

  it("chip-filter pushdown surfaces a match that ranks below the 200-row candidate cap", async () => {
    // Reproduces the original bug: without SQL pushdown, a needle that
    // ranks below the LIMIT 200 candidates is silently dropped after
    // in-memory filtering, even though it satisfies the chip filter.
    // Seed 250 dummy rows that share trigrams with the search term and a
    // single needle whose ai_keywords contain the rare chip value "Orange".
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");
    const PREFIX = "JEST-ITG-CAP-";
    const NEEDLE = `${PREFIX}NEEDLE-ORANGE`;

    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${`${PREFIX}%`}`);

    const dummies = Array.from({ length: 250 }, (_, i) => ({
      vendor: "JEST-CAP-VENDOR",
      catalog: `${PREFIX}DUMMY-${String(i).padStart(4, "0")}`,
      description: "JEST-CAP shared description token bundle",
      binLocations: [] as string[],
      aiKeywords: [] as string[],
    }));
    // Insert in chunks to stay under the parameter ceiling.
    for (let i = 0; i < dummies.length; i += 100) {
      await db.insert(inventoryTable).values(dummies.slice(i, i + 100));
    }
    await db.insert(inventoryTable).values({
      vendor: "JEST-CAP-VENDOR",
      catalog: NEEDLE,
      description: "JEST-CAP shared description token bundle",
      binLocations: [] as string[],
      aiKeywords: ["orange"],
    });

    try {
      const res = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: "JEST-CAP shared description token bundle", colorChip: "Orange" })
        .expect(200);
      expect(
        res.body.results.some(
          (r: { item: { catalog: string } }) => r.item.catalog === NEEDLE,
        ),
      ).toBe(true);
    } finally {
      await db
        .delete(inventoryTable)
        .where(sqlOp`${inventoryTable.catalog} LIKE ${`${PREFIX}%`}`);
    }
  }, 30_000);

  it("does not raise when keywords contain stray FTS operator characters", async () => {
    // websearch_to_tsquery is the hardened parser; freeform punctuation that
    // would crash to_tsquery (the previous implementation) must now round-trip
    // cleanly with a 200 response.
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "breaker & (20a) | <foo> !!!" })
      .expect(200);

    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/upsert-batch
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/upsert-batch", () => {
  const NEW_CATALOG = "JEST-ITG-UPSERT-001";

  afterEach(async () => {
    // Clean up any items created by upsert-batch tests
    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    await db.delete(inventoryTable).where(eq(inventoryTable.catalog, NEW_CATALOG));
  });

  it("returns 401 when no Authorization header is provided", async () => {
    await supertest(app)
      .post("/api/inventory/upsert-batch")
      .send({ items: [{ vendor: "TEST", catalog: NEW_CATALOG, description: "test" }] })
      .expect(401);
  });

  it("returns 401 when an invalid token is provided", async () => {
    await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", "Bearer invalid-token-xyz")
      .send({ items: [{ vendor: "TEST", catalog: NEW_CATALOG, description: "test" }] })
      .expect(401);
  });

  it("returns 400 when items array is empty", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ items: [] })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when items field is missing entirely", async () => {
    await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({})
      .expect(400);
  });

  it("inserts a new item and returns inserted=1, updated=0", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: "JEST-VENDOR",
            catalog: NEW_CATALOG,
            description: "Jest integration test item",
            binLocations: ["TEST-BIN"],
          },
        ],
      })
      .expect(200);

    expect(res.body.inserted).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(res.body.total).toBe(1);
  });

  it("handles two concurrent upserts of the same (vendor, catalog) without unique-constraint failure", async () => {
    const CONCURRENT_CATALOG = "JEST-ITG-UPSERT-CONCURRENT-001";
    const { db, inventoryTable } = await import("@workspace/db");
    const { and: andOp, sql: sqlOp } = await import("drizzle-orm");
    // Make sure the row does not pre-exist so both writers race on insert.
    await db
      .delete(inventoryTable)
      .where(
        andOp(
          sqlOp`UPPER(${inventoryTable.vendor}) = ${"JEST-VENDOR"}`,
          sqlOp`${inventoryTable.catalog} = ${CONCURRENT_CATALOG}`,
        ),
      );

    const send = (description: string) =>
      supertest(app)
        .post("/api/inventory/upsert-batch")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          items: [
            {
              vendor: "JEST-VENDOR",
              catalog: CONCURRENT_CATALOG,
              description,
              binLocations: ["RACE-BIN"],
            },
          ],
        });

    const [a, b] = await Promise.all([send("writer-a"), send("writer-b")]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Together they touched exactly one row: one insert, one update.
    expect(a.body.inserted + b.body.inserted).toBe(1);
    expect(a.body.updated + b.body.updated).toBe(1);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(
        andOp(
          sqlOp`UPPER(${inventoryTable.vendor}) = ${"JEST-VENDOR"}`,
          sqlOp`${inventoryTable.catalog} = ${CONCURRENT_CATALOG}`,
        ),
      );
    expect(rows.length).toBe(1);
    expect(["writer-a", "writer-b"]).toContain(rows[0]!.description);

    // Cleanup.
    await db
      .delete(inventoryTable)
      .where(
        andOp(
          sqlOp`UPPER(${inventoryTable.vendor}) = ${"JEST-VENDOR"}`,
          sqlOp`${inventoryTable.catalog} = ${CONCURRENT_CATALOG}`,
        ),
      );
  });

  it("returns 413 when the items array exceeds the per-batch cap", async () => {
    const oversized = Array.from({ length: 5001 }, (_, i) => ({
      vendor: "JEST-VENDOR",
      catalog: `JEST-ITG-OVERSIZED-${i}`,
      description: "x",
    }));

    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ items: oversized })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too many|max/i);
  });

  it("updates an existing item and returns inserted=0, updated=1", async () => {
    // First insert
    await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: "JEST-VENDOR",
            catalog: NEW_CATALOG,
            description: "Original description",
          },
        ],
      })
      .expect(200);

    // Now update
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: "JEST-VENDOR",
            catalog: NEW_CATALOG,
            description: "Updated description",
          },
        ],
      })
      .expect(200);

    expect(res.body.inserted).toBe(0);
    expect(res.body.updated).toBe(1);
    expect(res.body.total).toBe(1);
  });
});
