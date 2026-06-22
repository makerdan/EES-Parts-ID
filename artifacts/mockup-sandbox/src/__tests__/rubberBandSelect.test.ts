/**
 * rubberBandSelect.test.ts
 *
 * Exhaustive unit tests for the three pure functions exported from
 * src/utils/rubberBandSelect.ts:
 *   - normRect
 *   - aabbIntersects
 *   - hitTestZones
 *
 * Coverage categories:
 *   Happy path, Empty/null, Overflow/boundary,
 *   Unexpected shape, Boundary edge cases
 */

import { describe, it, expect } from "vitest";
import {
  normRect,
  aabbIntersects,
  hitTestZones,
  type ZoneRect,
} from "../utils/rubberBandSelect";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeZone(
  svgX: number,
  svgY: number,
  svgWidth: number,
  svgHeight: number,
): ZoneRect {
  return { svgX, svgY, svgWidth, svgHeight };
}

// ── normRect ───────────────────────────────────────────────────────────────────

describe("normRect", () => {
  describe("Happy path — all four drag directions", () => {
    it("top-left to bottom-right (natural direction)", () => {
      const r = normRect(10, 20, 110, 70);
      expect(r).toEqual({ svgX: 10, svgY: 20, svgWidth: 100, svgHeight: 50 });
    });

    it("bottom-right to top-left (reverse drag)", () => {
      const r = normRect(110, 70, 10, 20);
      expect(r).toEqual({ svgX: 10, svgY: 20, svgWidth: 100, svgHeight: 50 });
    });

    it("top-right to bottom-left", () => {
      const r = normRect(110, 20, 10, 70);
      expect(r).toEqual({ svgX: 10, svgY: 20, svgWidth: 100, svgHeight: 50 });
    });

    it("bottom-left to top-right", () => {
      const r = normRect(10, 70, 110, 20);
      expect(r).toEqual({ svgX: 10, svgY: 20, svgWidth: 100, svgHeight: 50 });
    });
  });

  it("produces a zero-size rect when start equals end", () => {
    const r = normRect(50, 50, 50, 50);
    expect(r).toEqual({ svgX: 50, svgY: 50, svgWidth: 0, svgHeight: 0 });
  });

  it("handles negative coordinates", () => {
    const r = normRect(-100, -50, -10, -5);
    expect(r).toEqual({ svgX: -100, svgY: -50, svgWidth: 90, svgHeight: 45 });
  });

  it("handles very large coordinates (Number.MAX_SAFE_INTEGER)", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const r = normRect(0, 0, big, big);
    expect(r.svgX).toBe(0);
    expect(r.svgY).toBe(0);
    expect(r.svgWidth).toBe(big);
    expect(r.svgHeight).toBe(big);
  });
});

// ── aabbIntersects ─────────────────────────────────────────────────────────────

describe("aabbIntersects", () => {
  describe("Happy path — rects that do overlap", () => {
    it("rect fully inside zone returns true", () => {
      const zone = makeZone(0, 0, 100, 100);
      const rect = makeZone(10, 10, 20, 20);
      expect(aabbIntersects(zone, rect)).toBe(true);
    });

    it("zone fully inside rect returns true", () => {
      const zone = makeZone(10, 10, 20, 20);
      const rect = makeZone(0, 0, 100, 100);
      expect(aabbIntersects(zone, rect)).toBe(true);
    });

    it("partial overlap from left edge", () => {
      const zone = makeZone(0, 0, 50, 50);
      const rect = makeZone(25, 0, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(true);
    });

    it("partial overlap from right edge", () => {
      const zone = makeZone(50, 0, 50, 50);
      const rect = makeZone(25, 0, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(true);
    });

    it("partial overlap from top edge", () => {
      const zone = makeZone(0, 0, 50, 50);
      const rect = makeZone(0, 25, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(true);
    });

    it("partial overlap from bottom edge", () => {
      const zone = makeZone(0, 50, 50, 50);
      const rect = makeZone(0, 25, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(true);
    });

    it("1×1 overlap in a corner", () => {
      const zone = makeZone(0, 0, 10, 10);
      const rect = makeZone(9, 9, 10, 10);
      expect(aabbIntersects(zone, rect)).toBe(true);
    });
  });

  describe("Boundary edge cases — touching but NOT overlapping (strict semantics)", () => {
    it("zone right edge exactly touches rect left edge → false", () => {
      const zone = makeZone(0, 0, 50, 50);
      const rect = makeZone(50, 0, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(false);
    });

    it("rect right edge exactly touches zone left edge → false", () => {
      const zone = makeZone(50, 0, 50, 50);
      const rect = makeZone(0, 0, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(false);
    });

    it("zone bottom edge exactly touches rect top edge → false", () => {
      const zone = makeZone(0, 0, 50, 50);
      const rect = makeZone(0, 50, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(false);
    });

    it("rect bottom edge exactly touches zone top edge → false", () => {
      const zone = makeZone(0, 50, 50, 50);
      const rect = makeZone(0, 0, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(false);
    });
  });

  describe("No overlap cases", () => {
    it("completely separate horizontally", () => {
      const zone = makeZone(0, 0, 50, 50);
      const rect = makeZone(100, 0, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(false);
    });

    it("completely separate vertically", () => {
      const zone = makeZone(0, 0, 50, 50);
      const rect = makeZone(0, 100, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(false);
    });

    it("separate diagonally", () => {
      const zone = makeZone(0, 0, 50, 50);
      const rect = makeZone(100, 100, 50, 50);
      expect(aabbIntersects(zone, rect)).toBe(false);
    });
  });
});

// ── hitTestZones ───────────────────────────────────────────────────────────────

describe("hitTestZones", () => {
  // ── Happy path ───────────────────────────────────────────────────────────────
  describe("Happy path", () => {
    it("returns zones that overlap the selection rect", () => {
      const zones: ZoneRect[] = [
        makeZone(0, 0, 100, 100),
        makeZone(200, 0, 100, 100),
        makeZone(400, 0, 100, 100),
      ];
      const rect = makeZone(50, 0, 200, 100); // covers first two zones
      const hits = hitTestZones(zones, rect);
      expect(hits).toHaveLength(2);
      expect(hits).toContain(zones[0]);
      expect(hits).toContain(zones[1]);
      expect(hits).not.toContain(zones[2]);
    });

    it("returns all zones when selection covers all of them", () => {
      const zones = [makeZone(0, 0, 10, 10), makeZone(50, 50, 10, 10)];
      const rect = makeZone(-100, -100, 500, 500);
      expect(hitTestZones(zones, rect)).toHaveLength(2);
    });

    it("returns single matching zone when only one overlaps", () => {
      const zones = [makeZone(0, 0, 50, 50), makeZone(200, 200, 50, 50)];
      const rect = makeZone(10, 10, 20, 20);
      const hits = hitTestZones(zones, rect);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toBe(zones[0]);
    });
  });

  // ── Empty / null ─────────────────────────────────────────────────────────────
  describe("Empty / null inputs", () => {
    it("returns [] for an empty zone array", () => {
      const rect = makeZone(0, 0, 100, 100);
      expect(hitTestZones([], rect)).toEqual([]);
    });

    it("returns [] when zones is null", () => {
      const rect = makeZone(0, 0, 100, 100);
      expect(hitTestZones(null, rect)).toEqual([]);
    });

    it("returns [] when zones is undefined", () => {
      const rect = makeZone(0, 0, 100, 100);
      expect(hitTestZones(undefined, rect)).toEqual([]);
    });

    it("returns [] when nothing overlaps the rect", () => {
      const zones = [makeZone(500, 500, 50, 50)];
      const rect = makeZone(0, 0, 100, 100);
      expect(hitTestZones(zones, rect)).toEqual([]);
    });
  });

  // ── Overflow / boundary ──────────────────────────────────────────────────────
  describe("Overflow / boundary", () => {
    it("handles MAX_SAFE_INTEGER coordinates without throwing", () => {
      const big = Number.MAX_SAFE_INTEGER;
      const zones = [makeZone(big - 100, big - 100, 50, 50)];
      const rect = makeZone(big - 110, big - 110, 200, 200);
      expect(() => hitTestZones(zones, rect)).not.toThrow();
      expect(hitTestZones(zones, rect)).toHaveLength(1);
    });

    it("handles a list of 1000 zones efficiently", () => {
      const zones: ZoneRect[] = Array.from({ length: 1000 }, (_, i) =>
        makeZone(i * 20, 0, 10, 10),
      );
      const rect = makeZone(0, 0, 100, 10); // first 5 zones (0-40px range, zones at 0,20,40)
      // zones at x=0(w=10), x=20(w=10), x=40(w=10) overlap rect 0-100
      const hits = hitTestZones(zones, rect);
      expect(hits.length).toBeGreaterThanOrEqual(5);
      expect(hits.length).toBeLessThan(1000);
    });

    it("returns [] for a degenerate rect with svgWidth < minPx", () => {
      const zones = [makeZone(0, 0, 100, 100)];
      const rect = makeZone(0, 0, 3, 100); // svgWidth=3 < minPx=8
      expect(hitTestZones(zones, rect, 8)).toEqual([]);
    });

    it("returns [] for a degenerate rect with svgHeight < minPx", () => {
      const zones = [makeZone(0, 0, 100, 100)];
      const rect = makeZone(0, 0, 100, 3); // svgHeight=3 < minPx=8
      expect(hitTestZones(zones, rect, 8)).toEqual([]);
    });

    it("zero-size rect (a point) inside a zone IS considered an intersection when minPx=0", () => {
      // A point (0×0 rect) at (50,50) is strictly inside zone (0,0,100,100).
      // With minPx=0 the degenerate guard (svgWidth < 0, svgHeight < 0) does NOT fire.
      // The strict AABB test passes for a point in the interior, so the zone is returned.
      const zones = [makeZone(0, 0, 100, 100)];
      const rect = makeZone(50, 50, 0, 0);
      expect(hitTestZones(zones, rect, 0)).toHaveLength(1);
    });

    it("returns results when rect exactly meets minPx threshold", () => {
      const zones = [makeZone(0, 0, 100, 100)];
      const rect = makeZone(0, 0, 8, 8);
      // 8 < 8 is false, so the degenerate guard doesn't fire
      expect(hitTestZones(zones, rect, 8)).toHaveLength(1);
    });
  });

  // ── Unexpected shape ─────────────────────────────────────────────────────────
  describe("Unexpected shape — malformed zones", () => {
    it("skips zones missing svgX without throwing", () => {
      const zones = [
        { svgY: 0, svgWidth: 50, svgHeight: 50 } as unknown as ZoneRect,
        makeZone(0, 0, 50, 50),
      ];
      const rect = makeZone(0, 0, 100, 100);
      expect(() => hitTestZones(zones, rect)).not.toThrow();
      const hits = hitTestZones(zones, rect);
      expect(hits).toHaveLength(1);
    });

    it("skips zones missing svgY without throwing", () => {
      const zones = [
        { svgX: 0, svgWidth: 50, svgHeight: 50 } as unknown as ZoneRect,
        makeZone(0, 0, 50, 50),
      ];
      const rect = makeZone(0, 0, 100, 100);
      expect(() => hitTestZones(zones, rect)).not.toThrow();
      const hits = hitTestZones(zones, rect);
      expect(hits).toHaveLength(1);
    });

    it("skips zones missing svgWidth without throwing", () => {
      const zones = [
        { svgX: 0, svgY: 0, svgHeight: 50 } as unknown as ZoneRect,
        makeZone(0, 0, 50, 50),
      ];
      const rect = makeZone(0, 0, 100, 100);
      const hits = hitTestZones(zones, rect);
      expect(hits).toHaveLength(1);
    });

    it("skips zones missing svgHeight without throwing", () => {
      const zones = [
        { svgX: 0, svgY: 0, svgWidth: 50 } as unknown as ZoneRect,
        makeZone(0, 0, 50, 50),
      ];
      const rect = makeZone(0, 0, 100, 100);
      const hits = hitTestZones(zones, rect);
      expect(hits).toHaveLength(1);
    });

    it("skips zones where coordinates are strings instead of numbers", () => {
      const zones = [
        { svgX: "0", svgY: "0", svgWidth: "50", svgHeight: "50" } as unknown as ZoneRect,
        makeZone(0, 0, 50, 50),
      ];
      const rect = makeZone(0, 0, 100, 100);
      expect(() => hitTestZones(zones, rect)).not.toThrow();
      const hits = hitTestZones(zones, rect);
      expect(hits).toHaveLength(1);
    });

    it("skips completely empty objects without throwing", () => {
      const zones = [{} as ZoneRect, makeZone(0, 0, 50, 50)];
      const rect = makeZone(0, 0, 100, 100);
      expect(() => hitTestZones(zones, rect)).not.toThrow();
      expect(hitTestZones(zones, rect)).toHaveLength(1);
    });

    it("handles NaN coordinate values gracefully", () => {
      const zones = [
        makeZone(NaN, NaN, NaN, NaN),
        makeZone(0, 0, 50, 50),
      ];
      const rect = makeZone(0, 0, 100, 100);
      // NaN is of type "number" so the type guard passes, but NaN < N = false, so no intersection
      expect(() => hitTestZones(zones, rect)).not.toThrow();
    });
  });

  // ── Boundary edge cases — strict vs inclusive semantics ──────────────────────
  describe("Boundary edge cases — strict (touching = no overlap)", () => {
    it("zone whose right edge exactly meets rect left edge is NOT included", () => {
      const zones = [
        makeZone(0, 0, 50, 50),  // right edge at x=50
      ];
      const rect = makeZone(50, 0, 50, 50);  // left edge at x=50
      expect(hitTestZones(zones, rect)).toEqual([]);
    });

    it("zone whose left edge exactly meets rect right edge is NOT included", () => {
      const zones = [
        makeZone(100, 0, 50, 50),  // left edge at x=100
      ];
      const rect = makeZone(0, 0, 100, 50);  // right edge at x=100
      expect(hitTestZones(zones, rect)).toEqual([]);
    });

    it("zone that overlaps by 1 unit IS included", () => {
      const zones = [makeZone(0, 0, 51, 50)]; // right edge at x=51
      const rect = makeZone(50, 0, 50, 50);   // left edge at x=50 → overlap of 1
      expect(hitTestZones(zones, rect)).toHaveLength(1);
    });
  });
});
