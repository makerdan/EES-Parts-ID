/**
 * autoNumberZones.test.ts
 *
 * Unit tests for the two pure functions that power the auto-number feature:
 *   - buildAutoNumPreview  — sorts selected zones and assigns sequential sectionNums
 *   - buildAutoNumSentinelMap — computes the two-phase sentinel plan that avoids
 *                              (aisleId, sectionNum) unique-constraint violations
 *
 * Coverage:
 *   buildAutoNumPreview
 *     1. Empty selection returns an empty array
 *     2. Zones are sorted by sortOrder, then by svgY as a tiebreaker
 *     3. sectionNums start at `start` and increment by `increment`
 *     4. A zero/negative increment is clamped to 1
 *     5. `digits` > 1 pads the display string with leading zeros
 *     6. `digits` = 1 produces plain decimal strings
 *     7. Only selected zones appear in the preview
 *
 *   buildAutoNumSentinelMap
 *     8. Sentinel values are negative integers starting at -1 when no negatives exist
 *     9. Sentinels start below the lowest existing negative in the affected aisle
 *    10. Each zone in the batch gets a unique sentinel
 *    11. Zones from different aisles share a single sentinel counter (per run)
 *    12. newSectionNum is carried through unchanged from the preview
 *    13. id is carried through unchanged from the preview zone
 *    14. Cyclic swap scenario: A(sectionNum=2)→1, B(sectionNum=1)→2 — two distinct sentinels
 *    15. Forward-shift scenario: A(1)→2, B(2)→3 — two distinct sentinels below existing baseline
 */

import { describe, it, expect } from "vitest";
import { buildAutoNumPreview, buildAutoNumSentinelMap, buildAutoNumCollisions } from "../pages/ZoneEditor";

// ── Minimal zone fixture factory ───────────────────────────────────────────────

function zone(
  id: number,
  aisleId: string,
  sectionNum: number,
  sortOrder = id,
  svgY = 0,
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
    svgY,
    svgWidth: 100,
    svgHeight: 80,
    sortOrder,
  };
}

// ── buildAutoNumPreview ────────────────────────────────────────────────────────

describe("buildAutoNumPreview", () => {

  // 1. Empty selection
  it("returns an empty array when selectedIds is empty", () => {
    const zones = [zone(1, "5", 1), zone(2, "5", 2)];
    expect(buildAutoNumPreview(zones, new Set(), 1, 1, 1)).toEqual([]);
  });

  // 2. Sorting — sortOrder takes precedence over svgY
  it("sorts by sortOrder first", () => {
    const zones = [
      zone(1, "5", 1, 10, 100),
      zone(2, "5", 1, 5,  200),
      zone(3, "5", 1, 20, 50),
    ];
    const result = buildAutoNumPreview(zones, new Set([1, 2, 3]), 1, 1, 1);
    expect(result.map((r) => r.zone.id)).toEqual([2, 1, 3]);
  });

  // 3. Sorting — svgY breaks sortOrder ties
  it("uses svgY as a tiebreaker when sortOrder values are equal", () => {
    const zones = [
      zone(1, "5", 1, 0, 300),
      zone(2, "5", 1, 0, 100),
      zone(3, "5", 1, 0, 200),
    ];
    const result = buildAutoNumPreview(zones, new Set([1, 2, 3]), 1, 1, 1);
    expect(result.map((r) => r.zone.id)).toEqual([2, 3, 1]);
  });

  // 4. sectionNum assignment — start and increment
  it("assigns sectionNums starting at `start` and incrementing by `increment`", () => {
    const zones = [zone(1, "5", 99), zone(2, "5", 99), zone(3, "5", 99)];
    const result = buildAutoNumPreview(zones, new Set([1, 2, 3]), 5, 3, 1);
    expect(result.map((r) => r.newSectionNum)).toEqual([5, 8, 11]);
  });

  // 5. Increment clamping — zero increment becomes 1
  it("clamps a zero increment to 1", () => {
    const zones = [zone(1, "5", 99), zone(2, "5", 99)];
    const result = buildAutoNumPreview(zones, new Set([1, 2]), 10, 0, 1);
    expect(result.map((r) => r.newSectionNum)).toEqual([10, 11]);
  });

  // 6. Increment clamping — negative increment becomes 1
  it("clamps a negative increment to 1", () => {
    const zones = [zone(1, "5", 99), zone(2, "5", 99)];
    const result = buildAutoNumPreview(zones, new Set([1, 2]), 10, -5, 1);
    expect(result.map((r) => r.newSectionNum)).toEqual([10, 11]);
  });

  // 7. Display — digits > 1 pads with leading zeros
  it("pads newSectionNumDisplay with leading zeros when digits > 1", () => {
    const zones = [zone(1, "5", 99), zone(2, "5", 99)];
    const result = buildAutoNumPreview(zones, new Set([1, 2]), 1, 1, 3);
    expect(result[0]!.newSectionNumDisplay).toBe("001");
    expect(result[1]!.newSectionNumDisplay).toBe("002");
  });

  // 8. Display — digits = 1 produces plain decimal strings
  it("produces plain decimal display strings when digits = 1", () => {
    const zones = [zone(1, "5", 99), zone(2, "5", 99)];
    const result = buildAutoNumPreview(zones, new Set([1, 2]), 7, 5, 1);
    expect(result[0]!.newSectionNumDisplay).toBe("7");
    expect(result[1]!.newSectionNumDisplay).toBe("12");
  });

  // 9. Only selected zones appear
  it("includes only the selected zones, not all zones", () => {
    const zones = [zone(1, "5", 1), zone(2, "5", 2), zone(3, "5", 3)];
    const result = buildAutoNumPreview(zones, new Set([1, 3]), 1, 1, 1);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.zone.id);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
  });

  // 10. Zone objects are carried through
  it("carries the full zone object through in each result entry", () => {
    const zones = [zone(42, "7", 5)];
    const result = buildAutoNumPreview(zones, new Set([42]), 1, 1, 1);
    expect(result[0]!.zone).toMatchObject({ id: 42, aisleId: "7", sectionNum: 5 });
  });

  // 11. newSortOrder equals newSectionNum for each entry
  it("sets newSortOrder equal to newSectionNum for each zone", () => {
    const zones = [zone(1, "5", 99), zone(2, "5", 99), zone(3, "5", 99)];
    const result = buildAutoNumPreview(zones, new Set([1, 2, 3]), 5, 3, 1);
    for (const entry of result) {
      expect(entry.newSortOrder).toBe(entry.newSectionNum);
    }
  });

  // 12. newSortOrder reflects the sequential values derived from start + increment
  it("newSortOrder matches the expected sequence (start=1, increment=2)", () => {
    const zones = [zone(1, "5", 99), zone(2, "5", 99), zone(3, "5", 99)];
    const result = buildAutoNumPreview(zones, new Set([1, 2, 3]), 1, 2, 1);
    expect(result.map((r) => r.newSortOrder)).toEqual([1, 3, 5]);
  });

  // 13. newSortOrder is distinct for every zone in the batch
  it("produces distinct newSortOrder values across all zones", () => {
    const zones = [zone(1, "5", 10), zone(2, "5", 20), zone(3, "5", 30)];
    const result = buildAutoNumPreview(zones, new Set([1, 2, 3]), 10, 10, 1);
    const orders = result.map((r) => r.newSortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  // 14. newSortOrder is preserved after zero-increment clamping
  it("newSortOrder reflects the clamped increment=1 when increment=0 is given", () => {
    const zones = [zone(1, "5", 99), zone(2, "5", 99)];
    const result = buildAutoNumPreview(zones, new Set([1, 2]), 10, 0, 1);
    expect(result.map((r) => r.newSortOrder)).toEqual([10, 11]);
  });
});

// ── buildAutoNumSentinelMap ────────────────────────────────────────────────────

describe("buildAutoNumSentinelMap", () => {

  // 1. No existing negatives — sentinels start at -1
  it("starts sentinels at -1 when the aisle has no existing negative sectionNums", () => {
    const zones = [zone(1, "5", 2), zone(2, "5", 1)];
    const preview = [
      { zone: zones[0]!, newSectionNum: 1 },
      { zone: zones[1]!, newSectionNum: 2 },
    ];
    const map = buildAutoNumSentinelMap(preview, zones);
    expect(map[0]!.sentinel).toBe(-1);
    expect(map[1]!.sentinel).toBe(-2);
  });

  // 2. Existing negatives — sentinels start below the minimum
  it("starts sentinels below the lowest existing negative in the affected aisle", () => {
    const allZones = [
      zone(10, "5", -1),
      zone(11, "5", -3),
      zone(1,  "5", 2),
      zone(2,  "5", 1),
    ];
    const preview = [
      { zone: allZones[2]!, newSectionNum: 1 },
      { zone: allZones[3]!, newSectionNum: 2 },
    ];
    const map = buildAutoNumSentinelMap(preview, allZones);
    expect(map[0]!.sentinel).toBe(-4);
    expect(map[1]!.sentinel).toBe(-5);
  });

  // 3. Each zone gets a unique sentinel
  it("assigns a distinct sentinel to every zone in the batch", () => {
    const zones = [zone(1, "5", 1), zone(2, "5", 2), zone(3, "5", 3)];
    const preview = zones.map((z, i) => ({ zone: z, newSectionNum: i + 4 }));
    const map = buildAutoNumSentinelMap(preview, zones);
    const sentinels = map.map((e) => e.sentinel);
    expect(new Set(sentinels).size).toBe(sentinels.length);
  });

  // 4. All sentinels are negative
  it("produces only negative sentinel values", () => {
    const zones = [zone(1, "5", 1), zone(2, "5", 2)];
    const preview = [
      { zone: zones[0]!, newSectionNum: 10 },
      { zone: zones[1]!, newSectionNum: 20 },
    ];
    const map = buildAutoNumSentinelMap(preview, zones);
    for (const entry of map) {
      expect(entry.sentinel).toBeLessThan(0);
    }
  });

  // 5. newSectionNum carried through unchanged
  it("carries each newSectionNum from the preview through to the map entry", () => {
    const zones = [zone(1, "5", 99)];
    const preview = [{ zone: zones[0]!, newSectionNum: 42 }];
    const map = buildAutoNumSentinelMap(preview, zones);
    expect(map[0]!.newSectionNum).toBe(42);
  });

  // 6. id carried through unchanged
  it("carries the zone id through to the map entry", () => {
    const zones = [zone(77, "5", 1)];
    const preview = [{ zone: zones[0]!, newSectionNum: 5 }];
    const map = buildAutoNumSentinelMap(preview, zones);
    expect(map[0]!.id).toBe(77);
  });

  // 7. Cyclic swap scenario — the classic bug trigger
  it("cyclic swap (A:2→1, B:1→2): produces two distinct negative sentinels", () => {
    const zoneA = zone(1, "5", 2);
    const zoneB = zone(2, "5", 1);
    const allZones = [zoneA, zoneB];
    const preview = [
      { zone: zoneA, newSectionNum: 1 },
      { zone: zoneB, newSectionNum: 2 },
    ];
    const map = buildAutoNumSentinelMap(preview, allZones);

    expect(map).toHaveLength(2);
    const [entryA, entryB] = map;
    expect(entryA!.sentinel).toBeLessThan(0);
    expect(entryB!.sentinel).toBeLessThan(0);
    expect(entryA!.sentinel).not.toBe(entryB!.sentinel);
    expect(entryA!.newSectionNum).toBe(1);
    expect(entryB!.newSectionNum).toBe(2);
  });

  // 8. Forward-shift overlap scenario
  it("forward shift (A:1→2, B:2→3, C:3→4): three distinct sentinels", () => {
    const zoneA = zone(1, "5", 1);
    const zoneB = zone(2, "5", 2);
    const zoneC = zone(3, "5", 3);
    const allZones = [zoneA, zoneB, zoneC];
    const preview = [
      { zone: zoneA, newSectionNum: 2 },
      { zone: zoneB, newSectionNum: 3 },
      { zone: zoneC, newSectionNum: 4 },
    ];
    const map = buildAutoNumSentinelMap(preview, allZones);

    expect(map).toHaveLength(3);
    const sentinels = map.map((e) => e.sentinel);
    expect(new Set(sentinels).size).toBe(3);
    for (const s of sentinels) {
      expect(s).toBeLessThan(0);
    }
    expect(map[0]!.newSectionNum).toBe(2);
    expect(map[1]!.newSectionNum).toBe(3);
    expect(map[2]!.newSectionNum).toBe(4);
  });

  // 9. Multi-aisle: negatives in one aisle don't affect another's sentinel baseline
  it("uses the lowest negative across ALL affected aisles as the sentinel baseline", () => {
    const allZones = [
      zone(10, "5", -5),
      zone(11, "6", -2),
      zone(1,  "5", 3),
      zone(2,  "6", 4),
    ];
    const preview = [
      { zone: allZones[2]!, newSectionNum: 10 },
      { zone: allZones[3]!, newSectionNum: 20 },
    ];
    const map = buildAutoNumSentinelMap(preview, allZones);
    expect(map[0]!.sentinel).toBe(-6);
    expect(map[1]!.sentinel).toBe(-7);
  });
});

// ── buildAutoNumCollisions ─────────────────────────────────────────────────────

describe("buildAutoNumCollisions", () => {

  // 1. No collision when all target sectionNums are free
  it("returns an empty array when no non-selected zone holds any target sectionNum", () => {
    const zones = [zone(1, "5", 1), zone(2, "5", 2), zone(3, "5", 3)];
    const preview = [
      { zone: zones[0]!, newSectionNum: 10 },
      { zone: zones[1]!, newSectionNum: 20 },
    ];
    const result = buildAutoNumCollisions(preview, zones, new Set([1, 2]));
    expect(result).toHaveLength(0);
  });

  // 2. Detects a collision with a non-selected zone in the same aisle
  it("returns the colliding (aisleId, sectionNum) when a non-selected zone already holds the target sectionNum", () => {
    const zones = [
      zone(1, "5", 1), // selected — being re-numbered to §3
      zone(2, "5", 3), // NOT selected — already holds §3
    ];
    const preview = [{ zone: zones[0]!, newSectionNum: 3 }];
    const result = buildAutoNumCollisions(preview, zones, new Set([1]));
    expect(result).toHaveLength(1);
    expect(result[0]!.sectionNum).toBe(3);
    expect(result[0]!.conflictingZoneId).toBe(2);
  });

  // 3. Does NOT flag a collision when the conflicting zone is itself selected
  it("ignores selected zones — they will be moved in Phase 1 and cannot collide in Phase 2", () => {
    // Classic cyclic swap: A(1)→2, B(2)→1 — both selected, no collision
    const zones = [zone(1, "5", 1), zone(2, "5", 2)];
    const preview = [
      { zone: zones[0]!, newSectionNum: 2 },
      { zone: zones[1]!, newSectionNum: 1 },
    ];
    const result = buildAutoNumCollisions(preview, zones, new Set([1, 2]));
    expect(result).toHaveLength(0);
  });

  // 4. Detects multiple collisions across different target sectionNums
  it("returns all collisions, one per conflicting (aisleId, sectionNum) pair", () => {
    const zones = [
      zone(1, "5", 1),  // selected → §10
      zone(2, "5", 2),  // selected → §20
      zone(3, "5", 10), // NOT selected — holds §10
      zone(4, "5", 20), // NOT selected — holds §20
    ];
    const preview = [
      { zone: zones[0]!, newSectionNum: 10 },
      { zone: zones[1]!, newSectionNum: 20 },
    ];
    const result = buildAutoNumCollisions(preview, zones, new Set([1, 2]));
    expect(result).toHaveLength(2);
    const sectionNums = result.map((c) => c.sectionNum).sort((a, b) => a - b);
    expect(sectionNums).toEqual([10, 20]);
  });

  // 5. Cross-aisle: non-selected zone in a different aisle does not collide
  it("does not collide when the non-selected zone is in a different aisle", () => {
    const zones = [
      zone(1, "5", 1), // selected, aisle 5 → §3
      zone(2, "6", 3), // NOT selected, but in aisle 6 — different aisle, no collision
    ];
    const preview = [{ zone: zones[0]!, newSectionNum: 3 }];
    const result = buildAutoNumCollisions(preview, zones, new Set([1]));
    expect(result).toHaveLength(0);
  });

  // 6. conflictingZoneId is the id of the blocking non-selected zone
  it("conflictingZoneId matches the id of the non-selected zone that holds the target sectionNum", () => {
    const zones = [
      zone(10, "5", 1), // selected → §99
      zone(77, "5", 99), // NOT selected — holds §99
    ];
    const preview = [{ zone: zones[0]!, newSectionNum: 99 }];
    const result = buildAutoNumCollisions(preview, zones, new Set([10]));
    expect(result[0]!.conflictingZoneId).toBe(77);
  });
});

// ── Multi-aisle detection (used by the cross-aisle warning banner) ─────────────

describe("multi-aisle detection via buildAutoNumPreview", () => {

  // The Auto-Number panel computes the distinct aisle count from autoNumPreview
  // using: new Set(autoNumPreview.map(p => normalizeAisleId(p.zone.aisleId))).size
  // These tests verify that buildAutoNumPreview correctly preserves the aisleId of
  // each zone so that the banner calculation is accurate.

  // 1. Single aisle — all preview entries share the same aisleId
  it("all preview entries have the same aisleId when all selected zones are in one aisle", () => {
    const zones = [zone(1, "5", 1), zone(2, "5", 2), zone(3, "5", 3)];
    const result = buildAutoNumPreview(zones, new Set([1, 2, 3]), 1, 1, 1);
    const aisleIds = new Set(result.map((r) => r.zone.aisleId));
    expect(aisleIds.size).toBe(1);
  });

  // 2. Multi-aisle — preview entries have distinct aisleIds
  it("preview entries reflect multiple aisleIds when selected zones span more than one aisle", () => {
    const zones = [
      zone(1, "5", 1),
      zone(2, "6", 1),
      zone(3, "7", 1),
    ];
    const result = buildAutoNumPreview(zones, new Set([1, 2, 3]), 1, 1, 1);
    const aisleIds = new Set(result.map((r) => r.zone.aisleId));
    expect(aisleIds.size).toBe(3);
  });

  // 3. Unselected zones do not contribute aisleIds to the preview
  it("aisleIds in the preview only reflect selected zones, not unselected ones", () => {
    const zones = [
      zone(1, "5", 1), // selected
      zone(2, "6", 2), // NOT selected
    ];
    const result = buildAutoNumPreview(zones, new Set([1]), 1, 1, 1);
    const aisleIds = result.map((r) => r.zone.aisleId);
    expect(aisleIds).toEqual(["5"]);
  });
});
