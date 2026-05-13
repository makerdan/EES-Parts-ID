/**
 * Integration tests for POST /api/admin/upload.
 *
 * The route accepts a raw CSV string, parses it server-side, and upserts rows
 * into the inventory table.  OpenAI is mocked; the real PostgreSQL DB is used.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: jest.fn() } }, audio: { transcriptions: { create: jest.fn() } } },
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
const ADMIN_SECRET = "jest-upload-test-secret";
let adminToken: string;

const UPLOAD_PREFIX = "JEST-UPLOAD-";

async function cleanupUploads() {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${"JEST-UPLOAD-%"}`);
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanupUploads();
}, 30_000);

afterAll(async () => {
  await cleanupUploads();
  // NOTE: do NOT call cleanupFixtures() here. It deletes JEST-ITG-% rows
  // which belong to inventory.integration.test.ts. When jest runs test
  // files in parallel workers, that cleanup races with inventory's
  // seedFixtures and silently wipes its fixtures, producing flaky failures
  // ("seeded item not in search results") in the parallel run only.
  await closePool();
}, 30_000);

afterEach(async () => {
  await cleanupUploads();
});

// ── Helper ─────────────────────────────────────────────────────────────────────
function buildCsv(rows: string[][]): string {
  return ["Vendor,Catalog,Description,BinLocation", ...rows.map(r => r.join(","))].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/upload
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/upload", () => {
  // ── Auth ──
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .send({ csv: buildCsv([["ACME", `${UPLOAD_PREFIX}001`, "Widget", "A1"]]) })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 when an invalid token is provided", async () => {
    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", "Bearer bad-token")
      .send({ csv: buildCsv([["ACME", `${UPLOAD_PREFIX}001`, "Widget", "A1"]]) })
      .expect(401);
  });

  // ── Malformed CSV → 400 ──
  it("returns 400 when the csv field is missing", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({})
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when the csv string is empty", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: "   " })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when the CSV has only a header row and no data rows", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: "Vendor,Catalog,Description" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when the CSV is missing required Vendor column", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: "Catalog,Description\n${UPLOAD_PREFIX}001,Widget" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/malformed|vendor|catalog/i);
  });

  it("returns 400 when the CSV is missing required Catalog column", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: "Vendor,Description\nACME,Widget" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/malformed|vendor|catalog/i);
  });

  // ── Valid CSV → 200 ──
  it("inserts new rows from a valid CSV and reports the correct row count", async () => {
    const csv = buildCsv([
      ["JEST-VENDOR", `${UPLOAD_PREFIX}001`, "Test breaker", "B-01"],
      ["JEST-VENDOR", `${UPLOAD_PREFIX}002`, "Test receptacle", "C-02"],
    ]);

    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.inserted).toBe(2);
    expect(res.body.updated).toBe(0);
    expect(res.body.total).toBe(2);
  });

  it("updates an existing row when the same vendor+catalog is uploaded again", async () => {
    const firstCsv = buildCsv([
      ["JEST-VENDOR", `${UPLOAD_PREFIX}001`, "Original description", ""],
    ]);
    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: firstCsv })
      .expect(200);

    const secondCsv = buildCsv([
      ["JEST-VENDOR", `${UPLOAD_PREFIX}001`, "Updated description", "D-99"],
    ]);
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: secondCsv })
      .expect(200);

    expect(res.body.inserted).toBe(0);
    expect(res.body.updated).toBe(1);
    expect(res.body.total).toBe(1);
  });

  it("skips CSV rows where vendor or catalog is blank", async () => {
    // Row 1: valid; Row 2: missing catalog; Row 3: missing vendor
    const csv = [
      "Vendor,Catalog,Description",
      `JEST-VENDOR,${UPLOAD_PREFIX}001,Good row`,
      `JEST-VENDOR,,No catalog`,
      `,${UPLOAD_PREFIX}002,No vendor`,
    ].join("\n");

    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    // Only the valid row should be processed
    expect(res.body.total).toBe(1);
    expect(res.body.inserted).toBe(1);
  });

  it("returns 413 when the csv string exceeds the per-upload size cap", async () => {
    // Build a CSV string a few bytes over the 15 MB cap. Use repeat to
    // avoid generating millions of array entries.
    const header = "Vendor,Catalog,Description,BinLocation\n";
    const padding = "x".repeat(15 * 1024 * 1024 + 1024);
    const csv = header + padding;

    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too large|limit/i);
  });

  it("handles two concurrent uploads of the same (vendor, catalog) without unique-constraint failure", async () => {
    const catalog = `${UPLOAD_PREFIX}CONCURRENT-001`;
    const csvA = buildCsv([["JEST-VENDOR", catalog, "writer-a", "A-1"]]);
    const csvB = buildCsv([["JEST-VENDOR", catalog, "writer-b", "B-2"]]);

    const send = (csv: string) =>
      supertest(app)
        .post("/api/admin/upload")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ csv });

    const [a, b] = await Promise.all([send(csvA), send(csvB)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.inserted + b.body.inserted).toBe(1);
    expect(a.body.updated + b.body.updated).toBe(1);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${catalog}`);
    expect(rows.length).toBe(1);
  });

  // ── Bin-preservation guard (Task #455) ──
  // A re-upload whose CSV omits the bin column must NOT clear bins that were
  // previously assigned to the same (vendor, catalog) row.
  it("preserves existing bins when a re-upload CSV omits the bin column", async () => {
    const catalog = `${UPLOAD_PREFIX}KEEP-BINS-001`;

    // Initial upload includes bins.
    const firstCsv = buildCsv([
      ["JEST-VENDOR", catalog, "Original description", "KEEP-A"],
    ]);
    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: firstCsv })
      .expect(200);

    // Re-upload uses a header WITHOUT a BinLocation column at all.
    const secondCsv = [
      "Vendor,Catalog,Description",
      `JEST-VENDOR,${catalog},Updated description`,
    ].join("\n");
    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: secondCsv })
      .expect(200);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${catalog}`);
    expect(rows.length).toBe(1);
    const bins = rows[0]!.binLocations;
    expect(Array.isArray(bins) ? bins : []).toEqual(["KEEP-A"]);
    expect(rows[0]!.description).toBe("Updated description");
  });

  it("handles quoted fields with commas inside correctly", async () => {
    const csv = [
      "Vendor,Catalog,Description,BinLocation",
      `JEST-VENDOR,${UPLOAD_PREFIX}QUOTED,"Breaker, 20A, 1 Pole",A-1`,
    ].join("\n");

    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.inserted).toBe(1);
    expect(res.body.total).toBe(1);
  });
});
