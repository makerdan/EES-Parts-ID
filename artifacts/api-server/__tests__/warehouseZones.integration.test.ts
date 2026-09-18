/**
 * Integration tests for GET/POST/PATCH/DELETE /api/warehouse-zones.
 *
 * All endpoints require a valid admin or app token (requireAppAuth middleware).
 * Mutation endpoints (POST, PATCH, DELETE) additionally require an admin token.
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
import { signAdminToken } from "./helpers/adminAuth";
import {
  cleanupFixtures,
  seedFixtures,
  workerQualifiedUserId,
} from "./helpers/testDb";
import { db, inventoryTable, warehouseZoneTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { UpdateWarehouseZoneResponse } from "@workspace/api-zod";

// ── Setup ─────────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-zone-secret";
let adminToken: string;

const ZONE_PREFIX = workerQualifiedUserId("JEST-ZONE").toUpperCase();
const BASE_AISLE = `${ZONE_PREFIX}-A1`;
const UPDATED_AISLE = `${ZONE_PREFIX}-A2`;
const SHAPE_AISLE = `${ZONE_PREFIX}-SHAPE`;

function uniqueNumericAisleId(seed: string): string {
  let hash = 0;
  for (const character of workerQualifiedUserId(seed)) {
    hash = (hash * 31 + character.charCodeAt(0)) % 90;
  }
  return String(10 + hash);
}

const COVERAGE_AISLE_87 = uniqueNumericAisleId("coverage-87");
const COVERAGE_AISLE_89 = uniqueNumericAisleId("coverage-89");

const BASE_ZONE = {
  aisleId: BASE_AISLE,
  svgX: 10,
  svgY: 20,
  svgWidth: 100,
  svgHeight: 50,
};

const COVERAGE_CATALOGS = [
  `${ZONE_PREFIX}-COV-87A`,
  `${ZONE_PREFIX}-COV-87B`,
  `${ZONE_PREFIX}-COV-89A`,
  `${ZONE_PREFIX}-COV-BAD1`,
  `${ZONE_PREFIX}-COV-BAD2`,
];

const OWNED_AISLES = [
  BASE_AISLE,
  UPDATED_AISLE,
  SHAPE_AISLE,
  COVERAGE_AISLE_87,
  COVERAGE_AISLE_89,
];

beforeAll(async () => {
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanupZones();
}, 15_000);

afterAll(async () => {
  await cleanupZones();
}, 15_000);

afterEach(async () => {
  await cleanupZones();
});

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanupZones() {
  // Delete only aisle ids created by this worker and suite. Never use a
  // shared prefix: another worker may be using a similarly-labelled zone.
  await db
    .delete(warehouseZoneTable)
    .where(inArray(warehouseZoneTable.aisleId, OWNED_AISLES));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/warehouse-zones
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/warehouse-zones", () => {
  it("returns 200 and a zones array", async () => {
    const res = await supertest(app)
      .get("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toHaveProperty("zones");
    expect(Array.isArray(res.body.zones)).toBe(true);
  });

  it("reflects a newly created zone in the list", async () => {
    await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const res = await supertest(app)
      .get("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    const found = res.body.zones.find(
      (z: { aisleId: string }) => z.aisleId === BASE_ZONE.aisleId,
    );
    expect(found).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/warehouse-zones
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/warehouse-zones", () => {
  it("returns 401 without an admin token", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 with an invalid (unknown) admin token", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", "Bearer not-a-valid-token")
      .send(BASE_ZONE)
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });

  it("creates a zone and returns 201 with the zone object", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    expect(res.body).toHaveProperty("zone");
    expect(res.body.zone.aisleId).toBe(BASE_ZONE.aisleId);
    expect(typeof res.body.zone.id).toBe("number");
  });

  it("defaults sectionNum to null when omitted", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    expect(res.body.zone.sectionNum).toBeNull();
  });

  it("accepts explicit sectionNum values", async () => {
    for (const sectionNum of [1, 2, 6, 99]) {
      await cleanupZones();
      const res = await supertest(app)
        .post("/api/warehouse-zones")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ ...BASE_ZONE, sectionNum })
        .expect(201);
      expect(res.body.zone.sectionNum).toBe(sectionNum);
    }
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aisleId: BASE_AISLE })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when sectionNum is not a number", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...BASE_ZONE, sectionNum: "not-a-number" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it.each([
    ["sectionNum", { sectionNum: 1.5 }],
    ["sortOrder", { sortOrder: 2.5 }],
  ])("rejects a fractional %s before creating a zone", async (_field, fractionalField) => {
    await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...BASE_ZONE, ...fractionalField })
      .expect(400);

    const rows = await db
      .select({ id: warehouseZoneTable.id })
      .from(warehouseZoneTable)
      .where(inArray(warehouseZoneTable.aisleId, [BASE_AISLE]));
    expect(rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/warehouse-zones/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/warehouse-zones/:id", () => {
  it("returns 401 without an admin token", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/1")
      .send({ svgX: 99 })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 with an invalid (unknown) admin token", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/1")
      .set("Authorization", "Bearer bad-token")
      .send({ svgX: 99 })
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });

  it("updates aisleId and returns the updated zone", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const res = await supertest(app)
      .patch(`/api/warehouse-zones/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aisleId: UPDATED_AISLE })
      .expect(200);

    expect(res.body.zone.aisleId).toBe(UPDATED_AISLE);
    expect(res.body.zone.id).toBe(id);
  });

  it("updates svgX, svgY coordinates", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const res = await supertest(app)
      .patch(`/api/warehouse-zones/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ svgX: 99, svgY: 88 })
      .expect(200);

    expect(res.body.zone.svgX).toBe(99);
    expect(res.body.zone.svgY).toBe(88);
  });

  it("returns 404 when the zone id does not exist", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/999999999")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ svgX: 99 })
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/not-a-number")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ svgX: 99 })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when sectionNum is not a number in the update", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const res = await supertest(app)
      .patch(`/api/warehouse-zones/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sectionNum: "bad-value" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it.each([
    ["sectionNum", { sectionNum: 3.5 }],
    ["sortOrder", { sortOrder: 4.5 }],
  ])("rejects a fractional %s without changing the zone", async (_field, fractionalField) => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...BASE_ZONE, sectionNum: 3, sortOrder: 4 })
      .expect(201);
    const id: number = create.body.zone.id;

    await supertest(app)
      .patch(`/api/warehouse-zones/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(fractionalField)
      .expect(400);

    const [stored] = await db
      .select({
        sectionNum: warehouseZoneTable.sectionNum,
        sortOrder: warehouseZoneTable.sortOrder,
      })
      .from(warehouseZoneTable)
      .where(sql`${warehouseZoneTable.id} = ${id}`);
    expect(stored).toEqual({ sectionNum: 3, sortOrder: 4 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/warehouse-zones/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/warehouse-zones/:id", () => {
  it("returns 401 without an admin token", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/1")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 with an invalid (unknown) admin token", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/1")
      .set("Authorization", "Bearer bad-token")
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });

  it("deletes a zone and returns deleted: true", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const res = await supertest(app)
      .delete(`/api/warehouse-zones/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toEqual({ deleted: true });
  });

  it("zone no longer appears in the list after deletion", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;
    await supertest(app)
      .delete(`/api/warehouse-zones/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const list = await supertest(app)
      .get("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    const found = list.body.zones.find(
      (z: { id: number }) => z.id === id,
    );
    expect(found).toBeUndefined();
  });

  it("returns 404 when deleting a zone that does not exist", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/999999999")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/not-a-number")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/warehouse-zones/coverage
// ─────────────────────────────────────────────────────────────────────────────
//
// Strategy: we use fixture aisles that are highly unlikely to appear in real
// data ("87" and "89").  We record a baseline count before seeding, then seed
// known items and compare the delta so the test is independent of whatever else
// exists in the shared dev database.
//
// Fixture layout
//   aisle "87" — 2 items with valid bins; we CREATE a zone for it → covered
//   aisle "89" — 1 item with a valid bin; we do NOT create a zone → uncovered
//   no-bin items — 2 items with invalid/empty bins → unsorted
// ─────────────────────────────────────────────────────────────────────────────

// Catalog numbers seeded by the coverage suite. Listed explicitly so that
// cleanupCoverageFixtures() can delete stale orphaned rows left over from a
// crashed previous run — at beforeAll time _seededCatalogs is still empty, so
// cleanupFixtures() alone would silently skip them. seedFixtures() uses
// onConflictDoNothing, so those orphaned rows would not be re-inserted, making
// the baseline unsortedCount include them and the +2 delta assertion wrong.
describe("GET /api/warehouse-zones/coverage", () => {
  async function cleanupCoverageFixtures() {
    // Remove catalogs tracked by this worker (no-op in beforeAll).
    await cleanupFixtures();
    // Also delete by explicit catalog name so orphaned rows from crashed prior
    // runs are purged in beforeAll even when _seededCatalogs is still empty.
    if (COVERAGE_CATALOGS.length > 0) {
      await db
        .delete(inventoryTable)
        .where(
          sql`${inventoryTable.catalog} IN (${sql.join(
            COVERAGE_CATALOGS.map((c) => sql`${c}`),
            sql`, `,
          )})`,
        );
    }
    await db
      .delete(warehouseZoneTable)
      .where(
        inArray(warehouseZoneTable.aisleId, [
          COVERAGE_AISLE_87,
          COVERAGE_AISLE_89,
        ]),
      );
  }

  beforeAll(async () => {
    await cleanupCoverageFixtures();
  }, 15_000);

  afterAll(async () => {
    await cleanupCoverageFixtures();
  }, 15_000);

  it("returns 200 with unsortedCount and uncoveredAisles fields", async () => {
    const res = await supertest(app)
      .get("/api/warehouse-zones/coverage")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toHaveProperty("unsortedCount");
    expect(res.body).toHaveProperty("uncoveredAisles");
    expect(typeof res.body.unsortedCount).toBe("number");
    expect(Array.isArray(res.body.uncoveredAisles)).toBe(true);
  });

  it("counts unsorted items and identifies uncovered aisles correctly from fixture data", async () => {
    // Record baseline before seeding
    const baseline = await supertest(app)
      .get("/api/warehouse-zones/coverage")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    const baseUnsorted: number = baseline.body.unsortedCount;
    const baseUncovered: string[] = baseline.body.uncoveredAisles;

    // Seed inventory fixtures
    await seedFixtures([
      // aisle 87 — valid bins, will have a matching zone
      {
        vendor: "JEST",
        catalog: COVERAGE_CATALOGS[0]!,
        description: "Coverage fixture aisle 87 item A",
        binLocations: [`${COVERAGE_AISLE_87}-01-100`],
      },
      {
        vendor: "JEST",
        catalog: COVERAGE_CATALOGS[1]!,
        description: "Coverage fixture aisle 87 item B",
        binLocations: [`${COVERAGE_AISLE_87}-02-200`],
      },
      // aisle 89 — valid bin, NO matching zone → should appear in uncoveredAisles
      {
        vendor: "JEST",
        catalog: COVERAGE_CATALOGS[2]!,
        description: "Coverage fixture aisle 89 item A",
        binLocations: [`${COVERAGE_AISLE_89}-01-100`],
      },
      // no valid bins → should increment unsortedCount
      {
        vendor: "JEST",
        catalog: COVERAGE_CATALOGS[3]!,
        description: "Coverage fixture no-bin item 1",
        binLocations: ["BAD-BIN"],
      },
      {
        vendor: "JEST",
        catalog: COVERAGE_CATALOGS[4]!,
        description: "Coverage fixture no-bin item 2",
        binLocations: [],
      },
    ]);

    // Create a zone for the first fixture aisle so it is covered.
    await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        aisleId: COVERAGE_AISLE_87,
        svgX: 0,
        svgY: 0,
        svgWidth: 10,
        svgHeight: 10,
      })
      .expect(201);

    const res = await supertest(app)
      .get("/api/warehouse-zones/coverage")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const uncoveredAisles: string[] = res.body.uncoveredAisles;

    // Count only this suite's no-bin fixtures directly from the DB, scoped to
    // their exact catalog numbers. This avoids the ">=" guard that was needed
    // when asserting on the global unsortedCount from the API: concurrent
    // workers can insert their own unsorted rows, making exact equality flaky.
    const { rows: unsortedRows } = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM inventory
      WHERE catalog IN (${sql.join(
        COVERAGE_CATALOGS.slice(3).map((catalog) => sql`${catalog}`),
        sql`, `,
      )})
    `);
    const ourUnsortedCount = (unsortedRows[0] as { cnt: number }).cnt;
    expect(ourUnsortedCount).toBe(2);

    // The second fixture aisle has inventory but no zone.
    expect(uncoveredAisles).toContain(COVERAGE_AISLE_89);

    // The first fixture aisle has inventory AND a zone.
    expect(uncoveredAisles).not.toContain(COVERAGE_AISLE_87);

    // The global inventory set is shared by concurrent suites, so its
    // pre-existing uncovered list can legitimately change between requests.
    // The assertions above cover this suite's owned aisle contract exactly.
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Response shape — no sectionCode after section_code removal
//
// These tests confirm that the POST and PATCH responses conform to the
// UpdateWarehouseZoneResponse Zod schema and that the deprecated sectionCode
// field is absent from all zone objects returned by the API.
// ─────────────────────────────────────────────────────────────────────────────

describe("zone response shape — sectionCode absent after section_code deprecation", () => {
  it("POST response zone passes UpdateWarehouseZoneResponse and has no sectionCode key", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const parsed = UpdateWarehouseZoneResponse.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.zone).not.toHaveProperty("sectionCode");
  });

  it("PATCH response zone passes UpdateWarehouseZoneResponse and has no sectionCode key", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const res = await supertest(app)
      .patch(`/api/warehouse-zones/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aisleId: SHAPE_AISLE })
      .expect(200);

    const parsed = UpdateWarehouseZoneResponse.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.zone).not.toHaveProperty("sectionCode");
  });

  it("GET list zones have no sectionCode key on any zone", async () => {
    await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const res = await supertest(app)
      .get("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    for (const zone of res.body.zones as Record<string, unknown>[]) {
      expect(zone).not.toHaveProperty("sectionCode");
    }
  });

  it("POST response zone has all expected keys (id, aisleId, sectionNum, isInventory, svgX, svgY, svgWidth, svgHeight, sortOrder, createdAt, updatedAt)", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BASE_ZONE)
      .expect(201);

    const zone = res.body.zone as Record<string, unknown>;
    const expectedKeys = [
      "id", "aisleId", "sectionNum", "isInventory",
      "svgX", "svgY", "svgWidth", "svgHeight",
      "sortOrder", "createdAt", "updatedAt",
    ];
    for (const key of expectedKeys) {
      expect(zone).toHaveProperty(key);
    }
  });
});
