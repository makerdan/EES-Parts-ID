/**
 * Integration tests for the applyZoneSectionNumFix startup migration.
 *
 * These tests verify the two skip-paths of the migration:
 *
 *   1. Already-correct database — all sentinel rows already have the expected
 *      section_num values; the function must return without modifying anything.
 *
 *   2. No zone data loaded — the DB has no rows matching the sentinel IDs;
 *      the function must exit gracefully without error.
 *
 * Both cases use a custom sentinel list injected into the function so that the
 * tests operate on rows they themselves insert (using an aisle prefix unique to
 * this suite) and never touch real warehouse data.
 */

// ── Imports ───────────────────────────────────────────────────────────────────
import { db, warehouseZoneTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { applyZoneSectionNumFix } from "../src/lib/zoneSectionNumFix";
import { closePool } from "./helpers/testDb";

// ── Shared constants ──────────────────────────────────────────────────────────

/** Aisle prefix that is guaranteed not to collide with real numeric aisles. */
const TEST_AISLE = "JEST-ZSNF";

// ── Teardown ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  await cleanupTestZones();
  await closePool();
}, 15_000);

afterEach(async () => {
  await cleanupTestZones();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cleanupTestZones() {
  await db
    .delete(warehouseZoneTable)
    .where(sql`${warehouseZoneTable.aisleId} LIKE ${TEST_AISLE + "%"}`);
}

/**
 * Insert two test zone rows and return their auto-assigned IDs along with
 * the section_nums they were given.
 */
async function insertTestZones(
  sectionNums: [number, number],
): Promise<[{ id: number; sectionNum: number }, { id: number; sectionNum: number }]> {
  const rows = await db
    .insert(warehouseZoneTable)
    .values([
      {
        aisleId: `${TEST_AISLE}-A`,
        sectionNum: sectionNums[0],
        svgX: 0,
        svgY: 0,
        svgWidth: 100,
        svgHeight: 80,
      },
      {
        aisleId: `${TEST_AISLE}-B`,
        sectionNum: sectionNums[1],
        svgX: 110,
        svgY: 0,
        svgWidth: 100,
        svgHeight: 80,
      },
    ])
    .returning({ id: warehouseZoneTable.id, sectionNum: warehouseZoneTable.sectionNum });

  return [
    { id: rows[0].id, sectionNum: rows[0].sectionNum as number },
    { id: rows[1].id, sectionNum: rows[1].sectionNum as number },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("applyZoneSectionNumFix — idempotency", () => {
  it("skips the UPDATE when all sentinels already carry the correct section_num", async () => {
    const [[zoneA, zoneB]] = await Promise.all([
      insertTestZones([7, 12]),
    ]);

    const customSentinels = [
      { id: zoneA.id, expectedSectionNum: 7 },
      { id: zoneB.id, expectedSectionNum: 12 },
    ];

    await expect(applyZoneSectionNumFix(customSentinels)).resolves.toBeUndefined();

    const after = await db
      .select({ id: warehouseZoneTable.id, sectionNum: warehouseZoneTable.sectionNum })
      .from(warehouseZoneTable)
      .where(inArray(warehouseZoneTable.id, [zoneA.id, zoneB.id]));

    const afterA = after.find((r) => r.id === zoneA.id);
    const afterB = after.find((r) => r.id === zoneB.id);

    expect(afterA?.sectionNum).toBe(7);
    expect(afterB?.sectionNum).toBe(12);
  });

  it("is safe to call a second time on already-correct data (true idempotency)", async () => {
    const [[zoneA, zoneB]] = await Promise.all([
      insertTestZones([3, 9]),
    ]);

    const customSentinels = [
      { id: zoneA.id, expectedSectionNum: 3 },
      { id: zoneB.id, expectedSectionNum: 9 },
    ];

    await applyZoneSectionNumFix(customSentinels);
    await expect(applyZoneSectionNumFix(customSentinels)).resolves.toBeUndefined();

    const after = await db
      .select({ id: warehouseZoneTable.id, sectionNum: warehouseZoneTable.sectionNum })
      .from(warehouseZoneTable)
      .where(inArray(warehouseZoneTable.id, [zoneA.id, zoneB.id]));

    expect(after.find((r) => r.id === zoneA.id)?.sectionNum).toBe(3);
    expect(after.find((r) => r.id === zoneB.id)?.sectionNum).toBe(9);
  });
});

describe("applyZoneSectionNumFix — no zone data loaded", () => {
  it("exits gracefully when no rows match the sentinel IDs", async () => {
    const nonExistentSentinels = [
      { id: 2_147_483_001, expectedSectionNum: 5 },
      { id: 2_147_483_002, expectedSectionNum: 10 },
    ];

    await expect(applyZoneSectionNumFix(nonExistentSentinels)).resolves.toBeUndefined();
  });

  it("does not throw when the sentinel list is empty", async () => {
    await expect(applyZoneSectionNumFix([])).resolves.toBeUndefined();
  });
});
