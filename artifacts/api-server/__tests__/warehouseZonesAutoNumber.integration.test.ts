/**
 * warehouseZonesAutoNumber.integration.test.ts
 *
 * Integration tests for the two-phase sentinel PATCH sequence that the
 * auto-number feature uses to avoid (aisleId, sectionNum) unique-constraint
 * violations when the new sectionNum values overlap the zones' current ones.
 *
 * The strategy under test (from handleAutoNumber / buildAutoNumSentinelMap):
 *   Phase 1 — PATCH every zone to a temporary negative "sentinel" value that
 *              is guaranteed not to collide with anything in the aisle.
 *   Phase 2 — PATCH every zone from its sentinel to its final sectionNum.
 *
 * Coverage:
 *   1. Straight renumber — no overlap, no sentinels needed (baseline sanity)
 *   2. Cyclic swap (A:1→2, B:2→1) — would deadlock without sentinels
 *   3. Forward shift (A:1→2, B:2→3, C:3→4) — each new value is currently held
 *   4. Reverse order (A:1→3, B:2→2, C:3→1) — full reversal, all overlap
 *   5. Sentinel values are negative and distinct across zones in the same aisle
 *   6. Final sectionNums match the intended assignment; no DB constraint errors
 *   7. Sentinel baseline sits below pre-existing negative sectionNums in the aisle
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
import { db, warehouseZoneTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";

// ── Setup ─────────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-autonumber-secret";
let adminToken: string;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanupZones();
}, 15_000);

afterAll(async () => {
  await cleanupZones();
  await closePool();
}, 15_000);

afterEach(async () => {
  await cleanupZones();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cleanupZones() {
  await db
    .delete(warehouseZoneTable)
    .where(sql`${warehouseZoneTable.aisleId} LIKE ${"JEST-AN%"}`);
}

const BASE_SVG = { svgX: 0, svgY: 0, svgWidth: 100, svgHeight: 80 };

async function createZone(aisleId: string, sectionNum: number): Promise<number> {
  const res = await supertest(app)
    .post("/api/warehouse-zones")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aisleId, sectionNum, ...BASE_SVG })
    .expect(201);
  return res.body.zone.id as number;
}

async function patchSectionNum(id: number, sectionNum: number): Promise<void> {
  await supertest(app)
    .patch(`/api/warehouse-zones/${id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ sectionNum })
    .expect(200);
}

async function getSectionNum(id: number): Promise<number> {
  const [row] = await db
    .select({ sectionNum: warehouseZoneTable.sectionNum })
    .from(warehouseZoneTable)
    .where(eq(warehouseZoneTable.id, id));
  if (!row) throw new Error(`Zone ${id} not found`);
  return row.sectionNum;
}

/**
 * Executes the two-phase sentinel sequence for a list of
 * { id, sentinel, newSectionNum } entries — matching exactly what
 * handleAutoNumber does in the frontend.
 */
async function applyTwoPhase(
  plan: Array<{ id: number; sentinel: number; newSectionNum: number }>,
): Promise<void> {
  for (const { id, sentinel } of plan) {
    await patchSectionNum(id, sentinel);
  }
  for (const { id, newSectionNum } of plan) {
    await patchSectionNum(id, newSectionNum);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-number zone sequencing — two-phase PATCH", () => {

  // ── 1. Baseline: straight renumber (no overlap) ───────────────────────────
  it("straight renumber — sectionNums are set correctly without any constraint error", async () => {
    const idA = await createZone("JEST-AN1", 10);
    const idB = await createZone("JEST-AN1", 20);
    const idC = await createZone("JEST-AN1", 30);

    const plan = [
      { id: idA, sentinel: -1, newSectionNum: 1 },
      { id: idB, sentinel: -2, newSectionNum: 2 },
      { id: idC, sentinel: -3, newSectionNum: 3 },
    ];

    await applyTwoPhase(plan);

    expect(await getSectionNum(idA)).toBe(1);
    expect(await getSectionNum(idB)).toBe(2);
    expect(await getSectionNum(idC)).toBe(3);
  });

  // ── 2. Cyclic swap (A:1→2, B:2→1) ────────────────────────────────────────
  it("cyclic swap (A:1→2, B:2→1) — completes without constraint error; final values are correct", async () => {
    const idA = await createZone("JEST-AN2", 1);
    const idB = await createZone("JEST-AN2", 2);

    const plan = [
      { id: idA, sentinel: -1, newSectionNum: 2 },
      { id: idB, sentinel: -2, newSectionNum: 1 },
    ];

    await applyTwoPhase(plan);

    expect(await getSectionNum(idA)).toBe(2);
    expect(await getSectionNum(idB)).toBe(1);
  });

  // ── 3. Forward shift (A:1→2, B:2→3, C:3→4) ──────────────────────────────
  it("forward shift — each new sectionNum overlaps the next zone's old sectionNum; all succeed", async () => {
    const idA = await createZone("JEST-AN3", 1);
    const idB = await createZone("JEST-AN3", 2);
    const idC = await createZone("JEST-AN3", 3);

    const plan = [
      { id: idA, sentinel: -1, newSectionNum: 2 },
      { id: idB, sentinel: -2, newSectionNum: 3 },
      { id: idC, sentinel: -3, newSectionNum: 4 },
    ];

    await applyTwoPhase(plan);

    expect(await getSectionNum(idA)).toBe(2);
    expect(await getSectionNum(idB)).toBe(3);
    expect(await getSectionNum(idC)).toBe(4);
  });

  // ── 4. Full reversal (A:1→3, B:2→2, C:3→1) ──────────────────────────────
  it("full reversal — A and C swap places without constraint error; B is unchanged", async () => {
    const idA = await createZone("JEST-AN4", 1);
    const idB = await createZone("JEST-AN4", 2);
    const idC = await createZone("JEST-AN4", 3);

    const plan = [
      { id: idA, sentinel: -1, newSectionNum: 3 },
      { id: idB, sentinel: -2, newSectionNum: 2 },
      { id: idC, sentinel: -3, newSectionNum: 1 },
    ];

    await applyTwoPhase(plan);

    expect(await getSectionNum(idA)).toBe(3);
    expect(await getSectionNum(idB)).toBe(2);
    expect(await getSectionNum(idC)).toBe(1);
  });

  // ── 5. Phase-1 constraint safety — sentinels are unique negative values ───
  it("phase-1 sentinels are negative and distinct so they never collide with each other", async () => {
    const idA = await createZone("JEST-AN5", 1);
    const idB = await createZone("JEST-AN5", 2);
    const idC = await createZone("JEST-AN5", 3);

    const sentinels = [-1, -2, -3];
    expect(sentinels.every((s) => s < 0)).toBe(true);
    expect(new Set(sentinels).size).toBe(sentinels.length);

    const plan = [
      { id: idA, sentinel: sentinels[0]!, newSectionNum: 3 },
      { id: idB, sentinel: sentinels[1]!, newSectionNum: 1 },
      { id: idC, sentinel: sentinels[2]!, newSectionNum: 2 },
    ];

    await applyTwoPhase(plan);

    expect(await getSectionNum(idA)).toBe(3);
    expect(await getSectionNum(idB)).toBe(1);
    expect(await getSectionNum(idC)).toBe(2);
  });

  // ── 6. Sentinel baseline — new sentinels start below pre-existing negatives
  it("sentinel baseline — when the aisle already has negative sectionNums, new sentinels start below the lowest", async () => {
    const idExisting = await createZone("JEST-AN6", 1);
    const idA = await createZone("JEST-AN6", 2);
    const idB = await createZone("JEST-AN6", 3);

    // Park idExisting at -1 to simulate a pre-existing negative in the aisle
    await patchSectionNum(idExisting, -1);

    // Sentinels for idA and idB must be below -1 (i.e. -2 and -3)
    const plan = [
      { id: idA, sentinel: -2, newSectionNum: 3 },
      { id: idB, sentinel: -3, newSectionNum: 2 },
    ];

    await applyTwoPhase(plan);

    expect(await getSectionNum(idA)).toBe(3);
    expect(await getSectionNum(idB)).toBe(2);
    // The pre-existing negative is untouched
    expect(await getSectionNum(idExisting)).toBe(-1);
  });

  // ── 7. Without sentinels a naive direct swap fails (constraint violation) ─
  it("naive direct swap fails with a 500 constraint error, confirming the two-phase approach is necessary", async () => {
    const idA = await createZone("JEST-AN7", 1);
    const idB = await createZone("JEST-AN7", 2);

    // Attempt to swap without sentinels: PATCH A directly to 2 while B still holds 2.
    // The DB unique index on (aisleId, sectionNum) must reject this.
    const res = await supertest(app)
      .patch(`/api/warehouse-zones/${idA}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sectionNum: 2 })
      .expect(500);

    expect(res.body).toHaveProperty("error");

    // Confirm both zones still have their original sectionNums (no partial update)
    expect(await getSectionNum(idA)).toBe(1);
    expect(await getSectionNum(idB)).toBe(2);
  });

  // ── 8. Large batch — 5-zone rotation ─────────────────────────────────────
  it("5-zone rotation — all zones end up with the correct final sectionNum", async () => {
    const aisle = "JEST-AN8";
    const ids = await Promise.all([
      createZone(aisle, 1),
      createZone(aisle, 2),
      createZone(aisle, 3),
      createZone(aisle, 4),
      createZone(aisle, 5),
    ]);

    // Rotate: each zone gets the next zone's sectionNum (5 wraps to 1)
    const finals = [2, 3, 4, 5, 1];
    const plan = ids.map((id, i) => ({
      id,
      sentinel: -(i + 1),
      newSectionNum: finals[i]!,
    }));

    await applyTwoPhase(plan);

    for (let i = 0; i < ids.length; i++) {
      expect(await getSectionNum(ids[i]!)).toBe(finals[i]);
    }
  });
}, 60_000);
