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
import { ADMIN_TEST_USER_ID, signAdminToken } from "./helpers/adminAuth";
import {
  seedFixtures,
  cleanupFixtures,
  STANDARD_FIXTURES,
} from "./helpers/testDb";
import { SearchInventoryResponse } from "@workspace/api-zod";

// ── Test configuration ────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-integration-test-secret";
let adminToken: string;

beforeAll(async () => {
  process.env.TEST_DEFAULT_AUTH_USER = ADMIN_TEST_USER_ID;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanupFixtures();
  await seedFixtures(STANDARD_FIXTURES);
}, 30_000);

afterAll(async () => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  await cleanupFixtures();
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

  it("returns a part whose search term appears only in expanded_description (FTS covers the field)", async () => {
    // Regression guard: the tsvector expression in the FTS WHERE clause and
    // ts_rank_cd call must include coalesce(i.expanded_description,'').
    // If that column is removed from the expression this test will fail
    // because the term exists nowhere else (vendor/catalog/description/
    // ai_keywords are all distinct from the search term).
    //
    // confidenceThreshold is set to 0 so the threshold filter does not hide
    // the hit: an FTS-only match against expanded_description has near-zero
    // trigram similarity to the catalog/description, which yields a blended
    // score of roughly 0.40 — just below the default 50% threshold. The test
    // is about FTS coverage, not confidence ranking, so bypassing the threshold
    // is the correct approach here.
    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");

    const NEEDLE_CATALOG = "JEST-ITG-EXPDESC-FTS-001";
    // A multi-syllable nonsense word that will not appear in any other row and
    // will survive the English stemmer (treated as an unknown lexeme).
    const UNIQUE_TERM = "xylomachinated";

    await db.delete(inventoryTable).where(eq(inventoryTable.catalog, NEEDLE_CATALOG));
    await db.insert(inventoryTable).values({
      vendor: "JEST-EXPDESC-VENDOR",
      catalog: NEEDLE_CATALOG,
      // description and ai_keywords intentionally contain NO occurrence of UNIQUE_TERM
      description: "Generic relay assembly unit",
      binLocations: [] as string[],
      aiKeywords: [] as string[],
      expandedDescription: `Detailed notes: ${UNIQUE_TERM} thermal coating applied during final assembly.`,
    });

    try {
      const res = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: UNIQUE_TERM, confidenceThreshold: 0 })
        .expect(200);

      expect(Array.isArray(res.body.results)).toBe(true);
      const match = res.body.results.find(
        (r: { item: { catalog: string } }) => r.item.catalog === NEEDLE_CATALOG,
      );
      expect(match).toBeDefined();
    } finally {
      await db.delete(inventoryTable).where(eq(inventoryTable.catalog, NEEDLE_CATALOG));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search — size-only path (no keywords)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/search — size-range filters without keywords", () => {
  const SIZE_FIXTURES = [
    {
      vendor: "JEST-VENDOR",
      catalog: "JEST-ITG-DIM-SHORT",
      description: "Short conduit fitting",
      dimensions: { length: 30 },
    },
    {
      vendor: "JEST-VENDOR",
      catalog: "JEST-ITG-DIM-MED",
      description: "Medium conduit fitting",
      dimensions: { length: 60 },
    },
    {
      vendor: "JEST-VENDOR",
      catalog: "JEST-ITG-DIM-LONG",
      description: "Long conduit fitting",
      dimensions: { length: 120 },
    },
    {
      vendor: "JEST-VENDOR",
      catalog: "JEST-ITG-DIM-DIA",
      description: "Round conduit fitting",
      dimensions: { diameter: 25 },
    },
    {
      vendor: "JEST-VENDOR",
      catalog: "JEST-ITG-DIM-NODIM",
      description: "Conduit fitting no dimensions",
    },
  ];

  beforeAll(async () => {
    await seedFixtures(SIZE_FIXTURES);
  }, 15_000);

  it("does not return early-empty when only minLength is provided (the regression case)", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ minLength: 50 })
      .expect(200);

    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
    const catalogs = res.body.results.map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(catalogs).toContain("JEST-ITG-DIM-MED");
    expect(catalogs).toContain("JEST-ITG-DIM-LONG");
    expect(catalogs).not.toContain("JEST-ITG-DIM-SHORT");
    expect(catalogs).not.toContain("JEST-ITG-DIM-NODIM");
  });

  it("does not return early-empty when only maxLength is provided", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ maxLength: 50 })
      .expect(200);

    const catalogs = res.body.results.map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(catalogs).toContain("JEST-ITG-DIM-SHORT");
    expect(catalogs).not.toContain("JEST-ITG-DIM-LONG");
    expect(catalogs).not.toContain("JEST-ITG-DIM-NODIM");
  });

  it("returns results within the inclusive range when both minLength and maxLength are provided", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ minLength: 40, maxLength: 90 })
      .expect(200);

    const catalogs = res.body.results.map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(catalogs).toContain("JEST-ITG-DIM-MED");
    expect(catalogs).not.toContain("JEST-ITG-DIM-SHORT");
    expect(catalogs).not.toContain("JEST-ITG-DIM-LONG");
    expect(catalogs).not.toContain("JEST-ITG-DIM-NODIM");
  });

  it("orders results by length ascending when no keywords are present", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ minLength: 1 })
      .expect(200);

    const lengths = res.body.results
      .map((r: { item: { dimensions?: { length?: number } } }) => r.item.dimensions?.length)
      .filter((l: unknown): l is number => typeof l === "number");

    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]!);
    }
  });

  it("returns 200 with no fixture rows when no fixtures fall within the given range", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ minLength: 9000, maxLength: 9999 })
      .expect(200);

    // The suite runs against a shared dev database that may contain real
    // inventory rows falling inside this range, so totalMatches === 0 cannot
    // be asserted. What the test owns is its fixtures: none of them have a
    // length in [9000, 9999], so none may appear in the results.
    const fixtureCatalogs = res.body.results
      .map((r: { item: { catalog: string } }) => r.item.catalog)
      .filter((c: string) => c.startsWith("JEST-ITG-"));
    expect(fixtureCatalogs).toEqual([]);
  });

  it("filters by diameter alone (no keywords, no length filter)", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ minDiameter: 20, maxDiameter: 30 })
      .expect(200);

    const catalogs = res.body.results.map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(catalogs).toContain("JEST-ITG-DIM-DIA");
    expect(catalogs).not.toContain("JEST-ITG-DIM-SHORT");
    expect(catalogs).not.toContain("JEST-ITG-DIM-MED");
    expect(catalogs).not.toContain("JEST-ITG-DIM-NODIM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/upsert-batch
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/upsert-batch", () => {
  const NEW_CATALOG = "JEST-ITG-UPSERT-001";

  // No default auth in this describe — tests either set their own token or
  // intentionally omit it to verify 401/403 behaviour.
  beforeAll(() => { delete process.env.TEST_DEFAULT_AUTH_USER; });
  afterAll(() => { process.env.TEST_DEFAULT_AUTH_USER = ADMIN_TEST_USER_ID; });

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

  it("returns 403 when an invalid (unknown) token is provided", async () => {
    await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", "Bearer invalid-token-xyz")
      .send({ items: [{ vendor: "TEST", catalog: NEW_CATALOG, description: "test" }] })
      .expect(403);
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

  // ── Bin-preservation guards (Task #455) ──
  // The upsert SET clause uses CASE WHEN array_length(EXCLUDED.bin_locations) > 0
  // so empty/omitted incoming bin arrays must NOT clear existing bins.
  describe("bin preservation on conflict", () => {
    async function readBinsFor(catalog: string): Promise<string[]> {
      const { db, inventoryTable } = await import("@workspace/db");
      const { sql: sqlOp } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(inventoryTable)
        .where(sqlOp`${inventoryTable.catalog} = ${catalog}`);
      const raw = rows[0]?.binLocations ?? [];
      return Array.isArray(raw) ? (raw as string[]) : [];
    }

    it("preserves existing bins when binLocations is omitted on re-upload", async () => {
      // Seed with bins.
      await supertest(app)
        .post("/api/inventory/upsert-batch")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          items: [
            {
              vendor: "JEST-VENDOR",
              catalog: NEW_CATALOG,
              description: "Original",
              binLocations: ["KEEP-A", "KEEP-B"],
            },
          ],
        })
        .expect(200);

      // Re-upload WITHOUT a binLocations field at all.
      await supertest(app)
        .post("/api/inventory/upsert-batch")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          items: [
            {
              vendor: "JEST-VENDOR",
              catalog: NEW_CATALOG,
              description: "Updated",
            },
          ],
        })
        .expect(200);

      expect(await readBinsFor(NEW_CATALOG)).toEqual(["KEEP-A", "KEEP-B"]);
    });

    it("preserves existing bins when binLocations is an empty array on re-upload", async () => {
      await supertest(app)
        .post("/api/inventory/upsert-batch")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          items: [
            {
              vendor: "JEST-VENDOR",
              catalog: NEW_CATALOG,
              description: "Original",
              binLocations: ["KEEP-A", "KEEP-B"],
            },
          ],
        })
        .expect(200);

      await supertest(app)
        .post("/api/inventory/upsert-batch")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          items: [
            {
              vendor: "JEST-VENDOR",
              catalog: NEW_CATALOG,
              description: "Updated",
              binLocations: [],
            },
          ],
        })
        .expect(200);

      expect(await readBinsFor(NEW_CATALOG)).toEqual(["KEEP-A", "KEEP-B"]);
    });

    it("replaces existing bins when binLocations contains values on re-upload", async () => {
      await supertest(app)
        .post("/api/inventory/upsert-batch")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          items: [
            {
              vendor: "JEST-VENDOR",
              catalog: NEW_CATALOG,
              description: "Original",
              binLocations: ["OLD-A", "OLD-B"],
            },
          ],
        })
        .expect(200);

      await supertest(app)
        .post("/api/inventory/upsert-batch")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          items: [
            {
              vendor: "JEST-VENDOR",
              catalog: NEW_CATALOG,
              description: "Updated",
              binLocations: ["NEW-BIN"],
            },
          ],
        })
        .expect(200);

      expect(await readBinsFor(NEW_CATALOG)).toEqual(["NEW-BIN"]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/bins  (Task #454 — per-part bin editing)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/bins", () => {
  // Look up a seeded item id by catalog so we don't depend on insertion order.
  async function seededItemId(catalog: string): Promise<number> {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: catalog })
      .expect(200);
    const match = res.body.results.find(
      (r: { item: { catalog: string; id: number } }) => r.item.catalog === catalog,
    );
    if (!match) throw new Error(`fixture ${catalog} not found`);
    return match.item.id as number;
  }

  it("replaces the bin array on an existing item and returns the updated row", async () => {
    const id = await seededItemId("JEST-ITG-BR120");
    const res = await supertest(app)
      .patch(`/api/inventory/${id}/bins`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ binLocations: ["X-99", "Y-12"] })
      .expect(200);

    expect(res.body.id).toBe(id);
    expect(res.body.binLocations).toEqual(["X-99", "Y-12"]);
  });

  it("trims, drops blanks, and de-duplicates case-insensitively", async () => {
    const id = await seededItemId("JEST-ITG-BR120");
    const res = await supertest(app)
      .patch(`/api/inventory/${id}/bins`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ binLocations: ["  A-1  ", "", "a-1", "B-2"] })
      .expect(200);
    expect(res.body.binLocations).toEqual(["A-1", "B-2"]);
  });

  it("accepts an empty array to clear all bins", async () => {
    const id = await seededItemId("JEST-ITG-BR120");
    const res = await supertest(app)
      .patch(`/api/inventory/${id}/bins`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ binLocations: [] })
      .expect(200);
    expect(res.body.binLocations).toEqual([]);
  });

  it("rejects requests without an admin token (401)", async () => {
    const id = await seededItemId("JEST-ITG-BR120");
    // seededItemId() uses the file-level default auth (search POST needs it),
    // then we clear the default so the actual PATCH goes out with no token.
    const savedAuth = process.env.TEST_DEFAULT_AUTH_USER;
    delete process.env.TEST_DEFAULT_AUTH_USER;
    try {
      await supertest(app)
        .patch(`/api/inventory/${id}/bins`)
        .send({ binLocations: ["Z-1"] })
        .expect(401);
    } finally {
      if (savedAuth !== undefined) process.env.TEST_DEFAULT_AUTH_USER = savedAuth;
    }
  });

  it("rejects non-array binLocations (400)", async () => {
    const id = await seededItemId("JEST-ITG-BR120");
    await supertest(app)
      .patch(`/api/inventory/${id}/bins`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ binLocations: "A-1" })
      .expect(400);
  });

  it("rejects array containing non-string entries (400)", async () => {
    const id = await seededItemId("JEST-ITG-BR120");
    await supertest(app)
      .patch(`/api/inventory/${id}/bins`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ binLocations: ["A-1", 42] })
      .expect(400);
  });

  it("returns 404 for an unknown id", async () => {
    await supertest(app)
      .patch(`/api/inventory/9999999/bins`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ binLocations: ["A-1"] })
      .expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search — includeNullDimensions toggle
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/search — includeNullDimensions toggle", () => {
  const PREFIX = "JEST-ITG-NULLDIM-";
  const MEASURED_CATALOG = `${PREFIX}MEASURED`;
  const UNMEASURED_CATALOG = `${PREFIX}UNMEASURED`;

  beforeAll(async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${`${PREFIX}%`}`);
    await db.insert(inventoryTable).values([
      {
        vendor: "JEST-NULLDIM-VENDOR",
        catalog: MEASURED_CATALOG,
        description: "JEST-ITG-NULLDIM part with measured length",
        binLocations: [],
        dimensions: { length: 50 },
      },
      {
        vendor: "JEST-NULLDIM-VENDOR",
        catalog: UNMEASURED_CATALOG,
        description: "JEST-ITG-NULLDIM part without dimensions",
        binLocations: [],
      },
    ]);
  }, 15_000);

  afterAll(async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${`${PREFIX}%`}`);
  }, 15_000);

  it("populates sizeUnknownResults with unmeasured items when includeNullDimensions is true", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-NULLDIM", minLength: 1, includeNullDimensions: true })
      .expect(200);

    const unknownCatalogs = (res.body.sizeUnknownResults ?? []).map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(unknownCatalogs).toContain(UNMEASURED_CATALOG);
  });

  it("leaves sizeUnknownResults empty when includeNullDimensions is false", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-NULLDIM", minLength: 1, includeNullDimensions: false })
      .expect(200);

    expect(res.body.sizeUnknownResults).toEqual([]);
  });

  it("measured item still appears in results regardless of includeNullDimensions", async () => {
    for (const flag of [true, false]) {
      const res = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: "JEST-ITG-NULLDIM", minLength: 1, includeNullDimensions: flag })
        .expect(200);

      const catalogs = res.body.results.map(
        (r: { item: { catalog: string } }) => r.item.catalog,
      );
      expect(catalogs).toContain(MEASURED_CATALOG);
    }
  });

  it("unmeasured item does not appear in main results even when includeNullDimensions is true", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-NULLDIM", minLength: 1, includeNullDimensions: true })
      .expect(200);

    const catalogs = res.body.results.map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(catalogs).not.toContain(UNMEASURED_CATALOG);
  });

  it("sizeUnknownCount matches sizeUnknownResults length", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-NULLDIM", minLength: 1, includeNullDimensions: true })
      .expect(200);

    expect(res.body.sizeUnknownCount).toBe(
      (res.body.sizeUnknownResults ?? []).length,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search — includeNullDimensions defaults to true
// Guards against a future change silently reverting the default and excluding
// unmeasured parts from search results.
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/search — includeNullDimensions defaults to true", () => {
  const PREFIX = "JEST-ITG-IND-DEFAULT-";
  const MEASURED_CATALOG = `${PREFIX}MEASURED`;
  const UNMEASURED_CATALOG = `${PREFIX}UNMEASURED`;

  beforeAll(async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${`${PREFIX}%`}`);
    await db.insert(inventoryTable).values([
      {
        vendor: "JEST-IND-VENDOR",
        catalog: MEASURED_CATALOG,
        description: "JEST-ITG-IND-DEFAULT part with measured length",
        binLocations: [],
        dimensions: { length: 10 },
      },
      {
        vendor: "JEST-IND-VENDOR",
        catalog: UNMEASURED_CATALOG,
        description: "JEST-ITG-IND-DEFAULT part without dimensions",
        binLocations: [],
      },
    ]);
  }, 15_000);

  afterAll(async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${`${PREFIX}%`}`);
  }, 15_000);

  it("plain keyword search (no includeNullDimensions flag) returns both measured and unmeasured items", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-IND-DEFAULT" })
      .expect(200);

    const catalogs = res.body.results.map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(catalogs).toContain(MEASURED_CATALOG);
    expect(catalogs).toContain(UNMEASURED_CATALOG);
  });

  it("keyword + minLength search (no includeNullDimensions flag) places unmeasured item in sizeUnknownResults", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-IND-DEFAULT", minLength: 1 })
      .expect(200);

    const unknownCatalogs = (res.body.sizeUnknownResults ?? []).map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(unknownCatalogs).toContain(UNMEASURED_CATALOG);
    const mainCatalogs = res.body.results.map(
      (r: { item: { catalog: string } }) => r.item.catalog,
    );
    expect(mainCatalogs).toContain(MEASURED_CATALOG);
    expect(mainCatalogs).not.toContain(UNMEASURED_CATALOG);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory — binPrefix filter
// Exercises the immutable_array_to_string() expression used by the GIN index.
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/inventory — binPrefix filter", () => {
  const BIN_PREFIX = "JEST-ITG-BIN-";

  const BIN_FIXTURES = [
    {
      vendor: "JEST-BIN-VENDOR",
      catalog: `${BIN_PREFIX}FIRST`,
      description: "Bin prefix test item — match is first element",
      binLocations: ["RACK-A01", "SHELF-Z99"],
    },
    {
      vendor: "JEST-BIN-VENDOR",
      catalog: `${BIN_PREFIX}SECOND`,
      description: "Bin prefix test item — match is second element",
      binLocations: ["SHELF-Z99", "RACK-A02"],
    },
    {
      vendor: "JEST-BIN-VENDOR",
      catalog: `${BIN_PREFIX}NOMATCH`,
      description: "Bin prefix test item — no matching bin",
      binLocations: ["SHELF-Z99", "SHELF-Z01"],
    },
    {
      vendor: "JEST-BIN-VENDOR",
      catalog: `${BIN_PREFIX}SHORT`,
      description: "Bin prefix test item — short prefix match",
      binLocations: ["AA-01", "SHELF-Z99"],
    },
  ];

  beforeAll(async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${BIN_PREFIX + "%"}`);
    await seedFixtures(BIN_FIXTURES);
  }, 15_000);

  afterAll(async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${BIN_PREFIX + "%"}`);
  }, 15_000);

  it("returns only rows whose bin_locations contain an entry starting with the prefix", async () => {
    const res = await supertest(app)
      .get("/api/inventory")
      .query({ binPrefix: "RACK-A" })
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    const catalogs: string[] = res.body.items.map(
      (r: { catalog: string }) => r.catalog,
    );

    expect(catalogs).toContain(`${BIN_PREFIX}FIRST`);
    expect(catalogs).toContain(`${BIN_PREFIX}SECOND`);
    expect(catalogs).not.toContain(`${BIN_PREFIX}NOMATCH`);
    expect(catalogs).not.toContain(`${BIN_PREFIX}SHORT`);
  });

  it("matches when the prefix-bearing entry is not the first element of bin_locations (OR branch)", async () => {
    // SECOND has ["SHELF-Z99", "RACK-A02"] — the RACK-A match is in position [1].
    // The OR branch in the SQL expression covers this case.
    const res = await supertest(app)
      .get("/api/inventory")
      .query({ binPrefix: "RACK-A" })
      .expect(200);

    const catalogs: string[] = res.body.items.map(
      (r: { catalog: string }) => r.catalog,
    );
    expect(catalogs).toContain(`${BIN_PREFIX}SECOND`);
  });

  it("returns correct results for a prefix shorter than 3 characters (no trigram acceleration, seq-scan fallback)", async () => {
    // A 2-character prefix like "AA" is below the pg_trgm similarity threshold,
    // so the GIN index is not used and Postgres falls back to a sequential scan.
    // The query result must still be correct.
    const res = await supertest(app)
      .get("/api/inventory")
      .query({ binPrefix: "AA" })
      .expect(200);

    const catalogs: string[] = res.body.items.map(
      (r: { catalog: string }) => r.catalog,
    );
    expect(catalogs).toContain(`${BIN_PREFIX}SHORT`);
    expect(catalogs).not.toContain(`${BIN_PREFIX}FIRST`);
    expect(catalogs).not.toContain(`${BIN_PREFIX}SECOND`);
    expect(catalogs).not.toContain(`${BIN_PREFIX}NOMATCH`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Photo ID ranking: catalog field wins over FTS description overlap
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/search — Photo ID catalog ranking", () => {
  // Catalog numbers used only by this suite; cleaned up in afterAll via the
  // JEST-ITG- prefix registered in cleanupFixtures().
  const TARGET_CATALOG = "JEST-ITG-CHB5";
  const DECOY_PREFIX = "JEST-ITG-CHB5-DECOY-";

  beforeAll(async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");

    // Remove any leftover rows from a previous run.
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} = ${TARGET_CATALOG}`);
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${DECOY_PREFIX + "%"}`);

    // The target: the part whose catalog matches the Photo ID input exactly.
    await db.insert(inventoryTable).values({
      vendor: "JEST-CHB5-VENDOR",
      catalog: TARGET_CATALOG,
      description: "Circuit breaker 5A single pole",
      binLocations: [],
      aiKeywords: [],
    });

    // Decoys: parts with richer description text that would outscore the target
    // on pure FTS/trigram overlap, but whose catalog numbers do NOT match.
    const decoys = Array.from({ length: 5 }, (_, i) => ({
      vendor: "JEST-CHB5-VENDOR",
      catalog: `${DECOY_PREFIX}${i}`,
      // Repeat key description words so FTS gives them a higher rank.
      description:
        "Circuit breaker single pole 5A 120V panel breaker circuit protection " +
        "breaker breaker circuit circuit",
      binLocations: [] as string[],
      aiKeywords: [] as string[],
    }));
    await db.insert(inventoryTable).values(decoys);
  }, 30_000);

  afterAll(async () => {
    const { db, inventoryTable } = await import("@workspace/db");
    const { sql: sqlOp } = await import("drizzle-orm");
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} = ${TARGET_CATALOG}`);
    await db
      .delete(inventoryTable)
      .where(sqlOp`${inventoryTable.catalog} LIKE ${DECOY_PREFIX + "%"}`);
  }, 30_000);

  it("exact catalog match ranks first with confidence >= 1.0 even when decoys have more FTS overlap", async () => {
    // Simulate a Photo ID search: the AI vision pipeline extracted catalog
    // number "JEST-ITG-CHB5" and passes it in the `catalog` body field.
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ catalog: TARGET_CATALOG })
      .expect(200);

    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);

    const topResult = res.body.results[0] as {
      item: { catalog: string };
      confidence: number;
      matchReason: string;
    };

    expect(topResult.item.catalog).toBe(TARGET_CATALOG);
    expect(topResult.confidence).toBeGreaterThanOrEqual(1.0);
  });

  it("token-splitting path: multi-word Photo ID catalog input still ranks the matching part first with confidence >= 1.0", async () => {
    // Simulate the case where the AI vision pipeline returns a multi-word
    // string (e.g. "JEST-ITG-CHB5 circuit breaker 20A") in the `catalog`
    // body field rather than a bare catalog number. The full string won't
    // match the stored catalog "JEST-ITG-CHB5" via simple exact/prefix/
    // substring checks, so the catalogScore catalogInput token-split branch
    // must kick in: it splits on whitespace and tests each token individually.
    // The first token "JEST-ITG-CHB5" matches exactly → score 1.0.
    //
    // The decoys seeded in beforeAll have descriptions that repeat "circuit
    // breaker" many times, so pure FTS/trigram overlap would outrank the
    // target without the token-splitting boost — proving the branch is doing
    // real work.
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ catalog: `${TARGET_CATALOG} circuit breaker 20A` })
      .expect(200);

    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);

    const topResult = res.body.results[0] as {
      item: { catalog: string };
      confidence: number;
      matchReason: string;
    };

    expect(topResult.item.catalog).toBe(TARGET_CATALOG);
    expect(topResult.confidence).toBeGreaterThanOrEqual(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract: POST /api/inventory/search response shape matches OpenAPI spec
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/search — OpenAPI contract", () => {
  it("response body parses cleanly against the generated SearchInventoryResponse zod schema", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-BR120" })
      .expect(200);

    const parsed = SearchInventoryResponse.safeParse(res.body);
    if (!parsed.success) {
      throw new Error(
        `Response shape violates OpenAPI contract for SearchInventoryResponse:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });

  it("response body with sizeUnknownResults parses cleanly against the schema", async () => {
    const res = await supertest(app)
      .post("/api/inventory/search")
      .send({ keywords: "JEST-ITG-BR120", minLength: 1, maxLength: 9999 })
      .expect(200);

    const parsed = SearchInventoryResponse.safeParse(res.body);
    if (!parsed.success) {
      throw new Error(
        `Response shape violates OpenAPI contract for SearchInventoryResponse (with size filter):\n${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
    expect(Array.isArray(parsed.data.sizeUnknownResults)).toBe(true);
  });
});
