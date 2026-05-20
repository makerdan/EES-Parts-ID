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

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildCsv(rows: string[][]): string {
  return ["Vendor,Catalog,Description,BinLocation", ...rows.map(r => r.join(","))].join("\n");
}

function buildBarcodeCsv(rows: Array<{ vendor: string; catalog: string; barcodes: string }>): string {
  const header = "Vendor,Catalog,Description,Barcodes";
  const lines = rows.map(r => `${r.vendor},${r.catalog},Test,"${r.barcodes}"`);
  return [header, ...lines].join("\n");
}

async function seedInventoryWithBarcodes(
  catalog: string,
  barcodes: string[],
): Promise<void> {
  await db
    .insert(inventoryTable)
    .values({
      vendor: "JEST-VENDOR",
      catalog,
      description: "Seed item for conflict test",
      binLocations: [],
      barcodes,
      aiKeywords: [],
    })
    .onConflictDoUpdate({
      target: [inventoryTable.vendor, inventoryTable.catalog],
      set: { barcodes: sql`EXCLUDED.barcodes` },
    });
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

  // ── Barcode round-trip (Task #507) ──
  // These tests guard against regressions where barcodes are silently dropped
  // on upload or incorrectly overwritten during a re-upload that lacks the
  // Barcodes column.

  it("saves barcodes from a CSV with a comma-separated (quoted) Barcodes cell", async () => {
    // When multiple barcodes are comma-delimited they must be wrapped in quotes
    // so the CSV parser treats the entire value as one field.
    const catalog = `${UPLOAD_PREFIX}BARCODE-COMMA`;
    const csv = [
      "Vendor,Catalog,Description,Barcodes",
      `JEST-VENDOR,${catalog},Widget,"012345678901,987654321098"`,
    ].join("\n");

    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${catalog}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.barcodes).toEqual(["012345678901", "987654321098"]);
  });

  it("saves barcodes from a CSV with a semicolon-separated Barcodes column", async () => {
    const catalog = `${UPLOAD_PREFIX}BARCODE-SEMI`;
    const csv = [
      "Vendor,Catalog,Description,Barcodes",
      `JEST-VENDOR,${catalog},Widget,012345678901;987654321098`,
    ].join("\n");

    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${catalog}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.barcodes).toEqual(["012345678901", "987654321098"]);
  });

  it("saves barcodes from a CSV with a mixed-separator Barcodes column", async () => {
    const catalog = `${UPLOAD_PREFIX}BARCODE-MIXED`;
    const csv = [
      "Vendor,Catalog,Barcodes",
      `JEST-VENDOR,${catalog},012300000001;023400000002|034500000003`,
    ].join("\n");

    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${catalog}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.barcodes).toEqual([
      "012300000001",
      "023400000002",
      "034500000003",
    ]);
  });

  it("preserves existing barcodes when a re-upload CSV omits the Barcodes column", async () => {
    const catalog = `${UPLOAD_PREFIX}BARCODE-PRESERVE`;

    // Initial upload — includes barcodes.
    const firstCsv = [
      "Vendor,Catalog,Description,Barcodes",
      `JEST-VENDOR,${catalog},Original,012345678901;987654321098`,
    ].join("\n");
    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: firstCsv })
      .expect(200);

    // Re-upload — Barcodes column is entirely absent.
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
    expect(rows[0]!.barcodes).toEqual(["012345678901", "987654321098"]);
    expect(rows[0]!.description).toBe("Updated description");
  });

  it("preserves existing barcodes when a re-upload CSV has an empty Barcodes cell", async () => {
    const catalog = `${UPLOAD_PREFIX}BARCODE-EMPTY-CELL`;

    // Initial upload — includes barcodes.
    const firstCsv = [
      "Vendor,Catalog,Barcodes",
      `JEST-VENDOR,${catalog},012345678901`,
    ].join("\n");
    await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: firstCsv })
      .expect(200);

    // Re-upload — Barcodes column present but cell is empty.
    const secondCsv = [
      "Vendor,Catalog,Barcodes",
      `JEST-VENDOR,${catalog},`,
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
    // Existing barcodes must not have been cleared.
    expect(rows[0]!.barcodes).toEqual(["012345678901"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/upload/preview — cross-item barcode conflict detection
// (Task #532)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/upload/preview — barcode conflict detection", () => {
  const CONFLICT_BARCODE = "JEST-BC-77777777";

  afterEach(async () => {
    await cleanupUploads();
  });

  it("returns barcodeStatus:'conflict' when an incoming barcode belongs to a different item", async () => {
    // Seed ITEM-A with the barcode that the CSV will try to assign to ITEM-B.
    const ownerCatalog = `${UPLOAD_PREFIX}CONFLICT-OWNER`;
    const incomingCatalog = `${UPLOAD_PREFIX}CONFLICT-INCOMING`;
    await seedInventoryWithBarcodes(ownerCatalog, [CONFLICT_BARCODE]);

    const csv = buildBarcodeCsv([
      { vendor: "JEST-VENDOR", catalog: incomingCatalog, barcodes: CONFLICT_BARCODE },
    ]);

    const res = await supertest(app)
      .post("/api/admin/upload/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.willBarcodeConflicts).toBe(1);
    const row = res.body.rows[0];
    expect(row.barcodeStatus).toBe("conflict");
    expect(row.conflictingItem).toBeDefined();
    expect(row.conflictingItem.catalog).toBe(ownerCatalog);
  });

  it("does NOT flag a conflict when the barcode belongs to the same item being re-uploaded", async () => {
    const catalog = `${UPLOAD_PREFIX}CONFLICT-SAME-ITEM`;
    await seedInventoryWithBarcodes(catalog, [CONFLICT_BARCODE]);

    // Re-uploading the same item with the same barcode — not a conflict.
    const csv = buildBarcodeCsv([
      { vendor: "JEST-VENDOR", catalog, barcodes: CONFLICT_BARCODE },
    ]);

    const res = await supertest(app)
      .post("/api/admin/upload/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.willBarcodeConflicts).toBe(0);
    const row = res.body.rows[0];
    expect(row.barcodeStatus).not.toBe("conflict");
    expect(row.conflictingItem).toBeUndefined();
  });

  it("reports no conflicts when the CSV has barcodes not present in the database", async () => {
    const catalog = `${UPLOAD_PREFIX}CONFLICT-NO-MATCH`;
    const csv = buildBarcodeCsv([
      { vendor: "JEST-VENDOR", catalog, barcodes: "JEST-BC-NEW-99999" },
    ]);

    const res = await supertest(app)
      .post("/api/admin/upload/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.willBarcodeConflicts).toBe(0);
    expect(res.body.rows[0].barcodeStatus).not.toBe("conflict");
  });

  it("flags each conflicting row individually when multiple rows conflict", async () => {
    const ownerA = `${UPLOAD_PREFIX}CONFLICT-OWN-A`;
    const ownerB = `${UPLOAD_PREFIX}CONFLICT-OWN-B`;
    await seedInventoryWithBarcodes(ownerA, ["JEST-BC-MULTI-A"]);
    await seedInventoryWithBarcodes(ownerB, ["JEST-BC-MULTI-B"]);

    const csv = buildBarcodeCsv([
      { vendor: "JEST-VENDOR", catalog: `${UPLOAD_PREFIX}CONFLICT-INC-A`, barcodes: "JEST-BC-MULTI-A" },
      { vendor: "JEST-VENDOR", catalog: `${UPLOAD_PREFIX}CONFLICT-INC-B`, barcodes: "JEST-BC-MULTI-B" },
      { vendor: "JEST-VENDOR", catalog: `${UPLOAD_PREFIX}CONFLICT-INC-C`, barcodes: "JEST-BC-FRESH-001" },
    ]);

    const res = await supertest(app)
      .post("/api/admin/upload/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.willBarcodeConflicts).toBe(2);
    expect(res.body.rows[0].barcodeStatus).toBe("conflict");
    expect(res.body.rows[1].barcodeStatus).toBe("conflict");
    expect(res.body.rows[2].barcodeStatus).not.toBe("conflict");
  });

  it("finds a conflict when the barcode is already duplicated across DB items (multi-owner edge case)", async () => {
    // Barcode assigned to TWO different DB items (data-integrity anomaly).
    // The incoming CSV targets a third item — should still detect conflict.
    const ownerA = `${UPLOAD_PREFIX}CONFLICT-DUP-A`;
    const ownerB = `${UPLOAD_PREFIX}CONFLICT-DUP-B`;
    const incoming = `${UPLOAD_PREFIX}CONFLICT-DUP-INC`;
    const dupBarcode = "JEST-BC-DUP-99001";

    await seedInventoryWithBarcodes(ownerA, [dupBarcode]);
    await seedInventoryWithBarcodes(ownerB, [dupBarcode]);

    const csv = buildBarcodeCsv([
      { vendor: "JEST-VENDOR", catalog: incoming, barcodes: dupBarcode },
    ]);

    const res = await supertest(app)
      .post("/api/admin/upload/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.willBarcodeConflicts).toBe(1);
    expect(res.body.rows[0].barcodeStatus).toBe("conflict");
    expect(res.body.rows[0].conflictingItem).toBeDefined();
  });

  it("returns 401 without a valid admin token", async () => {
    const csv = buildBarcodeCsv([
      { vendor: "JEST-VENDOR", catalog: `${UPLOAD_PREFIX}CONFLICT-AUTH`, barcodes: "JEST-BC-X" },
    ]);
    const res = await supertest(app)
      .post("/api/admin/upload/preview")
      .send({ csv })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });
});
