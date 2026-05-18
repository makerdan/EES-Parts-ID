/**
 * Integration tests for POST /api/inventory/add-part.
 *
 * Covers: 201 success, 409 duplicate detection, 400 missing-field validation,
 * and 401 unauthenticated access.
 *
 * Uses a real PostgreSQL database (DATABASE_URL env var).
 * OpenAI integration is mocked to avoid requiring a live API key.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
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
import { closePool } from "./helpers/testDb";
import { db, inventoryTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Setup / teardown ──────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-addpart-test-secret";
let adminToken: string;

const CATALOG_PREFIX = "JEST-ADDPART-";

async function cleanupAddPartRows() {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${"JEST-ADDPART-%"}`);
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanupAddPartRows();
}, 30_000);

afterAll(async () => {
  await cleanupAddPartRows();
  // NOTE: do NOT call cleanupFixtures() here — it deletes JEST-ITG-% rows
  // that belong to inventory.integration.test.ts and would cause flakiness
  // when jest runs test files in parallel.
  await closePool();
}, 30_000);

afterEach(async () => {
  await cleanupAddPartRows();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/add-part
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/add-part", () => {
  // ── Auth ──────────────────────────────────────────────────────────────────

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "JEST-VENDOR", catalog: `${CATALOG_PREFIX}AUTH-001` })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 when an invalid token is provided", async () => {
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", "Bearer invalid-token-xyz")
      .send({ vendor: "JEST-VENDOR", catalog: `${CATALOG_PREFIX}AUTH-002` })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it("returns 400 when vendor is missing", async () => {
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ catalog: `${CATALOG_PREFIX}VAL-001` })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/vendor.*catalog|catalog.*vendor|required/i);
  });

  it("returns 400 when catalog is missing", async () => {
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/vendor.*catalog|catalog.*vendor|required/i);
  });

  it("returns 400 when vendor is an empty string", async () => {
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "   ", catalog: `${CATALOG_PREFIX}VAL-003` })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when catalog is an empty string", async () => {
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog: "   " })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  // ── Success ───────────────────────────────────────────────────────────────

  it("returns 201 and the created item when valid vendor and catalog are provided", async () => {
    const catalog = `${CATALOG_PREFIX}SUCCESS-001`;
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(201);

    expect(res.body).toHaveProperty("item");
    expect(res.body.item.vendor).toBe("JEST-VENDOR");
    expect(res.body.item.catalog).toBe(catalog);
    expect(typeof res.body.item.id).toBe("number");
  });

  it("uppercases the vendor field on insert", async () => {
    const catalog = `${CATALOG_PREFIX}CASE-001`;
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "jest-vendor", catalog })
      .expect(201);

    expect(res.body.item.vendor).toBe("JEST-VENDOR");
  });

  it("stores the binLocation when one is provided", async () => {
    const catalog = `${CATALOG_PREFIX}BIN-001`;
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog, binLocation: "A-42" })
      .expect(201);

    expect(res.body.item.binLocations).toEqual(["A-42"]);
  });

  it("stores an empty binLocations array when binLocation is omitted", async () => {
    const catalog = `${CATALOG_PREFIX}BIN-002`;
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(201);

    expect(res.body.item.binLocations).toEqual([]);
  });

  it("persists the new row to the database", async () => {
    const catalog = `${CATALOG_PREFIX}DB-001`;
    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(201);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${catalog}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.vendor).toBe("JEST-VENDOR");
  });

  // ── Duplicate detection ───────────────────────────────────────────────────

  it("returns 409 when the same vendor+catalog combination already exists", async () => {
    const catalog = `${CATALOG_PREFIX}DUP-001`;

    // First insert — must succeed.
    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(201);

    // Second insert — must conflict.
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(409);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("409 response includes the vendor and catalog in the error message", async () => {
    const catalog = `${CATALOG_PREFIX}DUP-002`;

    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(201);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(409);

    expect(res.body.error).toContain("JEST-VENDOR");
    expect(res.body.error).toContain(catalog);
  });

  it("does not insert a duplicate row on a 409 conflict", async () => {
    const catalog = `${CATALOG_PREFIX}DUP-003`;

    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(201);

    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(409);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${catalog}`);
    expect(rows.length).toBe(1);
  });

  it("vendor comparison for duplicate detection is case-insensitive (lowercased input still conflicts)", async () => {
    const catalog = `${CATALOG_PREFIX}DUP-004`;

    // Insert with uppercase vendor.
    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog })
      .expect(201);

    // Re-insert with lowercase vendor — should still be a duplicate because
    // the endpoint uppercases vendor before the conflict check.
    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "jest-vendor", catalog })
      .expect(409);

    expect(res.body).toHaveProperty("error");
  });

  it("allows a different catalog for the same vendor without conflict", async () => {
    const catalog1 = `${CATALOG_PREFIX}NODUPS-001`;
    const catalog2 = `${CATALOG_PREFIX}NODUPS-002`;

    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog: catalog1 })
      .expect(201);

    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR", catalog: catalog2 })
      .expect(201);
  });

  it("allows the same catalog for a different vendor without conflict", async () => {
    const catalog = `${CATALOG_PREFIX}NODUPS-003`;

    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR-A", catalog })
      .expect(201);

    await supertest(app)
      .post("/api/inventory/add-part")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vendor: "JEST-VENDOR-B", catalog })
      .expect(201);
  });
});
