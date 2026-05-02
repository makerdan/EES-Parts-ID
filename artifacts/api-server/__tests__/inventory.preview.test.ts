/**
 * Integration tests for the "ask before changing" upload flow:
 *   - POST /api/inventory/preview-upsert
 *   - POST /api/inventory/upsert-batch with mode = add-new-only / overwrite-all / selected
 *
 * Verifies the contract documented in lib/api-spec/openapi.yaml and the
 * server-side rules in artifacts/api-server/src/routes/inventory.ts:
 *   • vendor + catalog text is the match key and is NEVER modified
 *   • blank/missing description NEVER overwrites a stored description
 *   • bins are merged additively (case-insensitive de-dupe)
 *   • selected mode requires selectedKeys and skips everything else
 */

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

import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "../src/routes/admin";
import {
  closePool,
  seedFixtures,
} from "./helpers/testDb";

const ADMIN_SECRET = "jest-preview-test-secret";
let adminToken: string;

// Catalog numbers used by this suite — all share the JEST-ITG-PRV- prefix
// so we can clean up ONLY our own rows. (Using the broader cleanupFixtures()
// helper from testDb would race with parallel test files that share the
// JEST-ITG- prefix.)
const PRV_PREFIX = "JEST-ITG-PRV-";
const CAT_EXISTING_BIN = `${PRV_PREFIX}BIN-001`;
const CAT_EXISTING_DESC = `${PRV_PREFIX}DESC-002`;
const CAT_EXISTING_BLANK_DESC = `${PRV_PREFIX}BLANK-003`;
const CAT_NEW_ONE = `${PRV_PREFIX}NEW-100`;
const CAT_NEW_TWO = `${PRV_PREFIX}NEW-101`;

async function cleanupPreviewRows() {
  const { db, inventoryTable } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} ILIKE ${PRV_PREFIX + "%"}`);
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
}, 30_000);

afterAll(async () => {
  await cleanupPreviewRows();
  await closePool();
}, 30_000);

beforeEach(async () => {
  await cleanupPreviewRows();
  await seedFixtures([
    {
      vendor: "EATON",
      catalog: CAT_EXISTING_BIN,
      description: "Existing description for bin test",
      binLocations: ["A-01"],
    },
    {
      vendor: "HUBBELL",
      catalog: CAT_EXISTING_DESC,
      description: "Original description",
      binLocations: ["B-02"],
    },
    {
      vendor: "LEVITON",
      catalog: CAT_EXISTING_BLANK_DESC,
      description: "Pre-existing description that must survive",
      binLocations: ["C-03"],
    },
  ]);
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

// ─────────────────────────────────────────────────────────────────────────────
// /preview-upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/preview-upsert", () => {
  it("requires admin auth", async () => {
    await supertest(app)
      .post("/api/inventory/preview-upsert")
      .send({ items: [{ vendor: "X", catalog: CAT_NEW_ONE, description: "n" }] })
      .expect(401);
  });

  it("classifies new / changed-bin / changed-desc / unchanged", async () => {
    const res = await supertest(app)
      .post("/api/inventory/preview-upsert")
      .set(auth())
      .send({
        items: [
          // New row → newCount += 1
          { vendor: "ACME", catalog: CAT_NEW_ONE, description: "Brand new" },
          // Same vendor/catalog as fixture, new bin → binChanged
          { vendor: "EATON", catalog: CAT_EXISTING_BIN, description: "Existing description for bin test", binLocations: ["A-99"] },
          // Same vendor/catalog as fixture, new desc → descChanged
          { vendor: "HUBBELL", catalog: CAT_EXISTING_DESC, description: "Brand new description" },
          // Same vendor/catalog as fixture, blank desc + same bin → unchanged
          { vendor: "LEVITON", catalog: CAT_EXISTING_BLANK_DESC, description: "", binLocations: ["C-03"] },
        ],
      })
      .expect(200);

    expect(res.body.totalIncoming).toBe(4);
    expect(res.body.newCount).toBe(1);
    expect(res.body.changedCount).toBe(2);
    expect(res.body.unchangedCount).toBe(1);

    const changes: Array<{ catalog: string; binChanged: boolean; descChanged: boolean }> = res.body.changes;
    expect(changes).toHaveLength(2);

    const binRow = changes.find((c) => c.catalog === CAT_EXISTING_BIN)!;
    expect(binRow.binChanged).toBe(true);
    expect(binRow.descChanged).toBe(false);

    const descRow = changes.find((c) => c.catalog === CAT_EXISTING_DESC)!;
    expect(descRow.descChanged).toBe(true);
    expect(descRow.binChanged).toBe(false);
  });

  it("matches keys case-insensitively", async () => {
    const res = await supertest(app)
      .post("/api/inventory/preview-upsert")
      .set(auth())
      .send({
        items: [
          // Lowercase catalog + lowercase vendor → must still match the seeded EATON / CAT_EXISTING_BIN
          { vendor: "eaton", catalog: CAT_EXISTING_BIN.toLowerCase(), description: "Existing description for bin test", binLocations: ["A-99"] },
        ],
      })
      .expect(200);

    expect(res.body.newCount).toBe(0);
    expect(res.body.changedCount).toBe(1);
  });

  it("returns 400 on empty items", async () => {
    await supertest(app)
      .post("/api/inventory/preview-upsert")
      .set(auth())
      .send({ items: [] })
      .expect(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /upsert-batch — mode behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/upsert-batch (mode-aware)", () => {
  it("add-new-only: inserts new rows but never modifies existing rows", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set(auth())
      .send({
        mode: "add-new-only",
        items: [
          { vendor: "ACME", catalog: CAT_NEW_ONE, description: "Fresh", binLocations: ["Z-01"] },
          // This one would change the existing bin — must be skipped
          { vendor: "EATON", catalog: CAT_EXISTING_BIN, description: "Should not overwrite", binLocations: ["A-99"] },
        ],
      })
      .expect(200);

    expect(res.body.inserted).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.total).toBe(2);

    // Verify the existing row was untouched.
    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [existing] = await db.select().from(inventoryTable).where(eq(inventoryTable.catalog, CAT_EXISTING_BIN));
    expect(existing.description).toBe("Existing description for bin test");
    expect(existing.binLocations).toEqual(["A-01"]);
  });

  it("overwrite-all: merges bins additively and replaces non-empty description", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set(auth())
      .send({
        mode: "overwrite-all",
        items: [
          { vendor: "EATON", catalog: CAT_EXISTING_BIN, description: "New description", binLocations: ["A-99"] },
        ],
      })
      .expect(200);

    expect(res.body.inserted).toBe(0);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toBe(0);

    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(inventoryTable).where(eq(inventoryTable.catalog, CAT_EXISTING_BIN));
    expect(row.description).toBe("New description");
    // Additive merge: original A-01 must still be present.
    expect(row.binLocations.sort()).toEqual(["A-01", "A-99"].sort());
  });

  it("overwrite-all: blank/missing description never overwrites stored description", async () => {
    await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set(auth())
      .send({
        mode: "overwrite-all",
        items: [
          { vendor: "LEVITON", catalog: CAT_EXISTING_BLANK_DESC, description: "", binLocations: ["C-99"] },
        ],
      })
      .expect(200);

    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(inventoryTable).where(eq(inventoryTable.catalog, CAT_EXISTING_BLANK_DESC));
    expect(row.description).toBe("Pre-existing description that must survive");
    expect(row.binLocations.sort()).toEqual(["C-03", "C-99"].sort());
  });

  it("overwrite-all: vendor and catalog text on existing rows are never modified", async () => {
    await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set(auth())
      .send({
        mode: "overwrite-all",
        items: [
          // Lowercase vendor + lowercase catalog should still match the existing row
          // and must NOT change the stored vendor or catalog casing.
          { vendor: "eaton", catalog: CAT_EXISTING_BIN.toLowerCase(), description: "Doesn't matter" },
        ],
      })
      .expect(200);

    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(inventoryTable).where(eq(inventoryTable.catalog, CAT_EXISTING_BIN));
    expect(row).toBeDefined();
    expect(row.vendor).toBe("EATON");
    expect(row.catalog).toBe(CAT_EXISTING_BIN);
  });

  it("selected: applies updates only for selectedKeys; skips other matches; still inserts new rows", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set(auth())
      .send({
        mode: "selected",
        selectedKeys: [{ vendor: "EATON", catalog: CAT_EXISTING_BIN }],
        items: [
          // selected → applied
          { vendor: "EATON", catalog: CAT_EXISTING_BIN, description: "Selected updates", binLocations: ["A-99"] },
          // existing match but NOT selected → skipped
          { vendor: "HUBBELL", catalog: CAT_EXISTING_DESC, description: "This must be ignored" },
          // brand new row — always inserted regardless of selectedKeys
          { vendor: "ACME", catalog: CAT_NEW_TWO, description: "Brand new row" },
        ],
      })
      .expect(200);

    expect(res.body.inserted).toBe(1);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.total).toBe(3);

    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");

    const [selectedRow] = await db.select().from(inventoryTable).where(eq(inventoryTable.catalog, CAT_EXISTING_BIN));
    expect(selectedRow.description).toBe("Selected updates");
    expect(selectedRow.binLocations.sort()).toEqual(["A-01", "A-99"].sort());

    const [skippedRow] = await db.select().from(inventoryTable).where(eq(inventoryTable.catalog, CAT_EXISTING_DESC));
    expect(skippedRow.description).toBe("Original description");

    const [newRow] = await db.select().from(inventoryTable).where(eq(inventoryTable.catalog, CAT_NEW_TWO));
    expect(newRow).toBeDefined();
  });

  it("dedupes duplicate logical keys server-side (case-variant catalog) before applying", async () => {
    // Two rows with the same (vendor, catalog) modulo case — server must
    // collapse them into one operation, merging bins and using the last
    // non-empty description.
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set(auth())
      .send({
        mode: "overwrite-all",
        items: [
          { vendor: "EATON", catalog: CAT_EXISTING_BIN, description: "", binLocations: ["A-99"] },
          { vendor: "eaton", catalog: CAT_EXISTING_BIN.toLowerCase(), description: "Final desc", binLocations: ["A-77"] },
        ],
      })
      .expect(200);

    expect(res.body.inserted).toBe(0);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.total).toBe(1); // deduped count

    const { db, inventoryTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(inventoryTable).where(eq(inventoryTable.catalog, CAT_EXISTING_BIN));
    expect(row.description).toBe("Final desc");
    expect(row.binLocations.sort()).toEqual(["A-01", "A-77", "A-99"].sort());
  });

  it("selected: returns 400 when selectedKeys is missing", async () => {
    await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set(auth())
      .send({
        mode: "selected",
        items: [{ vendor: "ACME", catalog: CAT_NEW_ONE, description: "x" }],
      })
      .expect(400);
  });
});
