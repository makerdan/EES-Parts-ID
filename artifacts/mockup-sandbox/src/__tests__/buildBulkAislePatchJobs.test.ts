/**
 * buildBulkAislePatchJobs.test.ts
 *
 * Unit tests for the pure `buildBulkAislePatchJobs` function that handles
 * aisle re-assignment for multi-selected zones, including automatic sentinel
 * sectionNum allocation to resolve unique-constraint collisions.
 *
 * Coverage:
 *   1. No-conflict case — bodies contain only aisleId (sectionNum untouched)
 *   2. Intra-batch conflict — two zones share sectionNum, one gets a sentinel
 *   3. Target aisle already occupied — collision with non-selected resident zone
 *   4. Sentinel allocation — new sentinels fall below existing negative sectionNums
 *   5. Passthrough when sectionNum is explicitly provided in updates
 *   6. Undo snapshot correctness — before/after always reflect original vs. saved
 */

import { describe, it, expect } from "vitest";
import { buildBulkAislePatchJobs } from "../pages/ZoneEditor";

// ── Minimal zone fixture factory ───────────────────────────────────────────────

function zone(
  id: number,
  aisleId: string,
  sectionNum: number,
): {
  id: number;
  aisleId: string;
  sectionNum: number;
  isInventory: boolean;
  svgX: number;
  svgY: number;
  svgWidth: number;
  svgHeight: number;
  sortOrder: number;
} {
  return {
    id,
    aisleId,
    sectionNum,
    isInventory: true,
    svgX: 0,
    svgY: 0,
    svgWidth: 100,
    svgHeight: 80,
    sortOrder: id,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("buildBulkAislePatchJobs", () => {

  // ── 1. No-conflict case ────────────────────────────────────────────────────

  it("no-conflict — bodies contain only aisleId when sectionNums are unique in target", () => {
    const zones = [
      zone(1, "12", 1),
      zone(2, "12", 2),
      zone(3, "12", 3),
    ];
    const jobs = buildBulkAislePatchJobs([1, 2, 3], zones, { aisleId: "15" });

    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job.body).toEqual({ aisleId: "15" });
      expect(job.body).not.toHaveProperty("sectionNum");
    }
  });

  it("no-conflict — after snapshots reflect the zone's existing sectionNum in the new aisle", () => {
    const zones = [zone(1, "12", 5), zone(2, "13", 7)];
    const jobs = buildBulkAislePatchJobs([1, 2], zones, { aisleId: "20" });

    const j1 = jobs.find((j) => j.id === 1)!;
    const j2 = jobs.find((j) => j.id === 2)!;

    expect(j1.after).toMatchObject({ aisleId: "20", sectionNum: 5 });
    expect(j2.after).toMatchObject({ aisleId: "20", sectionNum: 7 });
  });

  // ── 2. Intra-batch conflict ────────────────────────────────────────────────

  it("intra-batch conflict — when two selected zones share sectionNum=2, the first keeps it and the second gets a sentinel", () => {
    const zones = [
      zone(1, "10", 2),
      zone(2, "11", 2),
    ];
    const jobs = buildBulkAislePatchJobs([1, 2], zones, { aisleId: "30" });

    expect(jobs).toHaveLength(2);

    const j1 = jobs.find((j) => j.id === 1)!;
    const j2 = jobs.find((j) => j.id === 2)!;

    expect(j1.body).toEqual({ aisleId: "30" });
    expect(j1.after.sectionNum).toBe(2);

    expect(j2.after.sectionNum).toBeLessThan(0);
    expect(j2.body).toHaveProperty("sectionNum");
    expect((j2.body as { sectionNum: number }).sectionNum).toBeLessThan(0);
  });

  it("intra-batch conflict — the two zones' resolved sectionNums are distinct", () => {
    const zones = [zone(1, "A", 5), zone(2, "B", 5), zone(3, "C", 5)];
    const jobs = buildBulkAislePatchJobs([1, 2, 3], zones, { aisleId: "99" });

    const resolved = jobs.map((j) => j.after.sectionNum as number);
    expect(new Set(resolved).size).toBe(3);
  });

  // ── 3. Target aisle already occupied ──────────────────────────────────────

  it("target occupied — zone whose sectionNum matches a non-selected resident gets a sentinel", () => {
    const residentZone = zone(99, "15", 3);
    const selectedZone = zone(1, "12", 3);
    const allZones = [residentZone, selectedZone];

    const jobs = buildBulkAislePatchJobs([1], allZones, { aisleId: "15" });
    const j = jobs[0]!;

    expect(j.after.sectionNum).not.toBe(3);
    expect(j.after.sectionNum).toBeLessThan(0);
    expect(j.body).toHaveProperty("sectionNum");
  });

  it("target occupied — zone whose sectionNum is free keeps it (no sentinel needed)", () => {
    const residentZone = zone(99, "15", 1);
    const selectedZone = zone(1, "12", 4);
    const allZones = [residentZone, selectedZone];

    const jobs = buildBulkAislePatchJobs([1], allZones, { aisleId: "15" });
    const j = jobs[0]!;

    expect(j.body).toEqual({ aisleId: "15" });
    expect(j.after.sectionNum).toBe(4);
  });

  // ── 4. Sentinel allocation below existing negatives ────────────────────────

  it("sentinel allocation — starts below the lowest existing negative in the target aisle", () => {
    const allZones = [
      zone(10, "15", -1),
      zone(11, "15", -2),
      zone(1, "12", 3),
      zone(2, "13", 3),
    ];

    const jobs = buildBulkAislePatchJobs([1, 2], allZones, { aisleId: "15" });

    const j1 = jobs.find((j) => j.id === 1)!;
    const j2 = jobs.find((j) => j.id === 2)!;

    expect(j1.after.sectionNum).toBe(3);
    expect(j2.after.sectionNum).toBe(-3);
  });

  it("sentinel allocation — second conflict gets -4 when target already has -1, -2, -3", () => {
    const allZones = [
      zone(10, "15", -1),
      zone(11, "15", -2),
      zone(12, "15", -3),
      zone(1, "10", 5),
      zone(2, "11", 5),
      zone(3, "12", 5),
    ];

    const jobs = buildBulkAislePatchJobs([1, 2, 3], allZones, { aisleId: "15" });
    const sentinels = jobs
      .filter((j) => j.after.sectionNum! < 0)
      .map((j) => j.after.sectionNum as number)
      .sort((a, b) => a - b);

    expect(sentinels[0]).toBeLessThanOrEqual(-4);
    const set = new Set(sentinels);
    expect(set.size).toBe(sentinels.length);
  });

  // ── 5. Passthrough when sectionNum is explicitly set ──────────────────────

  it("passthrough — when sectionNum is in updates, all zones get the same body without conflict resolution", () => {
    const zones = [zone(1, "12", 1), zone(2, "13", 1)];
    const updates = { aisleId: "20", sectionNum: 7 };
    const jobs = buildBulkAislePatchJobs([1, 2], zones, updates);

    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.body).toBe(updates);
    }
  });

  it("passthrough — when no aisleId in updates, all zones get the same body", () => {
    const zones = [zone(1, "12", 1), zone(2, "13", 1)];
    const updates = { sectionNum: 42 };
    const jobs = buildBulkAislePatchJobs([1, 2], zones, updates);

    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.body).toBe(updates);
    }
  });

  // ── 6. Undo snapshot correctness ──────────────────────────────────────────

  it("snapshot — before.sectionNum is the zone's original sectionNum even when a sentinel is assigned", () => {
    const allZones = [
      zone(99, "15", 2),
      zone(1, "12", 2),
    ];
    const jobs = buildBulkAislePatchJobs([1], allZones, { aisleId: "15" });
    const j = jobs[0]!;

    expect(j.before.sectionNum).toBe(2);
    expect(j.before.aisleId).toBe("12");
  });

  it("snapshot — after.sectionNum reflects the sentinel actually written, not the original", () => {
    const allZones = [
      zone(99, "15", 2),
      zone(1, "12", 2),
    ];
    const jobs = buildBulkAislePatchJobs([1], allZones, { aisleId: "15" });
    const j = jobs[0]!;

    expect(j.after.sectionNum).toBeLessThan(0);
    expect(j.after.aisleId).toBe("15");
  });

  it("snapshot — before.aisleId reflects zone's original aisle (not the target)", () => {
    const zones = [zone(1, "12", 1)];
    const jobs = buildBulkAislePatchJobs([1], zones, { aisleId: "99" });
    expect(jobs[0]!.before.aisleId).toBe("12");
    expect(jobs[0]!.after.aisleId).toBe("99");
  });

  it("snapshot — no-conflict case before and after are both set correctly", () => {
    const zones = [zone(1, "7", 3)];
    const jobs = buildBulkAislePatchJobs([1], zones, { aisleId: "8" });
    const j = jobs[0]!;

    expect(j.before).toMatchObject({ aisleId: "7", sectionNum: 3 });
    expect(j.after).toMatchObject({ aisleId: "8", sectionNum: 3 });
  });

  it("passthrough snapshot — before captures original fields, after mirrors updates", () => {
    const zones = [zone(1, "12", 5)];
    const updates = { aisleId: "20", sectionNum: 9 };
    const jobs = buildBulkAislePatchJobs([1], zones, updates);
    const j = jobs[0]!;

    expect(j.before.aisleId).toBe("12");
    expect(j.before.sectionNum).toBe(5);
    expect(j.after).toBe(updates as typeof j.after);
  });
});
