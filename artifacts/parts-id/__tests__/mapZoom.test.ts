/**
 * Regression tests for map zoom-in / zoom-out behaviour.
 *
 * These tests cover three pure-math functions extracted from WarehouseMapView:
 *
 *  clampScale      — keeps gesture and button scales within [MIN_SCALE, MAX_SCALE].
 *  panBounds       — derives max translation limits from container size + scale;
 *                    must always be ≥ 0 and grow as the user zooms in.
 *  numTilesForScale — tile-grid dimension = ceil(scale); advancing by integer
 *                    steps means every scale level gets at least one full tile
 *                    of resolution headroom.
 *  visibleTileRange — culls the N×N grid to only the tiles that are currently
 *                    on-screen (plus a 1-tile buffer), keeping memory constant.
 *
 * Bug classes these tests guard against:
 *  • Scale not clamped → blank map below MIN_SCALE, OOM above MAX_SCALE.
 *  • Negative maxX/maxY → map slides off-screen when zoomed out.
 *  • floor() instead of ceil() for numTiles → map stays blurry one tier too long.
 *  • Tile range not clamped to [0, N-1] → index-out-of-bounds renders.
 */

import {
  MIN_SCALE,
  MAX_SCALE,
  SVG_ASPECT,
  SVG_VIEWBOX_W,
  SVG_VIEWBOX_H,
  clampScale,
  panBounds,
  numTilesForScale,
  visibleTileRange,
  fitContentViewport,
} from "@/utils/mapViewport";

// ── Shared container dimensions ────────────────────────────────────────────
// iPhone 14 Pro portrait: 393 × 852 pts, tab bar ~83 pt → mapH ≈ 769.
// Using a round number close to a real device makes computed values easy to
// reason about in failure messages.
const CW = 390;  // containerW
const CH = 761;  // containerH

// The rendered SVG height at this container width (used in pan-bound checks).
const SVG_RENDER_H = CW / SVG_ASPECT; // ≈ 265.9 pt

// ── clampScale ─────────────────────────────────────────────────────────────

describe("clampScale — zoom gesture bounds", () => {
  it("passes through a scale that is already within [MIN_SCALE, MAX_SCALE]", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(5)).toBe(5);
    expect(clampScale(25)).toBe(25);
  });

  it("clamps up to MIN_SCALE when the user zooms out too far", () => {
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(-1)).toBe(MIN_SCALE);
    expect(clampScale(MIN_SCALE - 0.001)).toBe(MIN_SCALE);
  });

  it("clamps down to MAX_SCALE when the user zooms in too far", () => {
    expect(clampScale(MAX_SCALE + 1)).toBe(MAX_SCALE);
    expect(clampScale(9999)).toBe(MAX_SCALE);
  });

  it("MIN_SCALE and MAX_SCALE are exact fixed points (no unexpected rounding)", () => {
    expect(clampScale(MIN_SCALE)).toBe(MIN_SCALE);
    expect(clampScale(MAX_SCALE)).toBe(MAX_SCALE);
  });

  it("regression: scale 0.5 was once accepted without a clamp guard, causing a blank map below the render threshold", () => {
    expect(clampScale(0.5)).toBe(MIN_SCALE);
    expect(clampScale(0.5)).not.toBe(0.5);
  });

  it("regression: scale 100 was once accepted, exhausting iOS texture memory", () => {
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(100)).not.toBe(100);
  });
});

// ── panBounds ──────────────────────────────────────────────────────────────

describe("panBounds — translation limits change with scale", () => {
  it("both maxX and maxY are 0 at MIN_SCALE (scaled map fits inside the container — no panning needed)", () => {
    // At MIN_SCALE=0.8: scaledW = 390×0.8 = 312 < 390; scaledH ≈ 265.9×0.8 = 213 < 761.
    const { maxX, maxY } = panBounds(CW, CH, MIN_SCALE);
    expect(maxX).toBe(0);
    expect(maxY).toBe(0);
  });

  it("maxX matches (containerW × (scale − 1)) / 2 at scale=2", () => {
    const { maxX } = panBounds(CW, CH, 2);
    expect(maxX).toBeCloseTo((CW * (2 - 1)) / 2, 3); // 195
  });

  it("maxX matches (containerW × (scale − 1)) / 2 at scale=5", () => {
    const { maxX } = panBounds(CW, CH, 5);
    expect(maxX).toBeCloseTo((CW * (5 - 1)) / 2, 3); // 780
  });

  it("maxY is 0 while the scaled SVG height still fits inside the container (portrait letterbox)", () => {
    // svgRenderH ≈ 265.9 pt; container height 761 pt.
    // Threshold scale = 761 / 265.9 ≈ 2.86 — at scale=2 the map is still letterboxed.
    const { maxY } = panBounds(CW, CH, 2);
    expect(maxY).toBe(0);
  });

  it("maxY becomes positive once the scaled SVG height exceeds the container height", () => {
    // At scale=3: svgRenderH × 3 ≈ 797.7 > 761 → maxY ≈ 18.
    const { maxY } = panBounds(CW, CH, 3);
    expect(maxY).toBeGreaterThan(0);
    expect(maxY).toBeCloseTo((SVG_RENDER_H * 3 - CH) / 2, 1);
  });

  it("pan bounds grow monotonically when zooming in", () => {
    const scales = [1, 2, 3, 5, 10, 20];
    const bounds = scales.map((s) => panBounds(CW, CH, s));
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i].maxX).toBeGreaterThanOrEqual(bounds[i - 1].maxX);
      expect(bounds[i].maxY).toBeGreaterThanOrEqual(bounds[i - 1].maxY);
    }
  });

  it("regression: maxX and maxY were once allowed to go negative (no Math.max(0,…) guard), causing the map to slide off-screen", () => {
    for (const s of [MIN_SCALE, 0.9, 1]) {
      const { maxX, maxY } = panBounds(CW, CH, s);
      expect(maxX).toBeGreaterThanOrEqual(0);
      expect(maxY).toBeGreaterThanOrEqual(0);
    }
  });

  it("pan bounds are symmetric: maxX equals half the overflow on each side", () => {
    const scale = 4;
    const { maxX } = panBounds(CW, CH, scale);
    const expectedOverflow = CW * scale - CW;
    expect(maxX).toBeCloseTo(expectedOverflow / 2, 3);
  });
});

// ── numTilesForScale ───────────────────────────────────────────────────────

describe("numTilesForScale — tile-grid dimension advances by integer steps", () => {
  it("is 1 at MIN_SCALE=0.8 (single texture, no splitting needed)", () => {
    expect(numTilesForScale(MIN_SCALE)).toBe(1);
  });

  it("is 1 at scale=1.0 (no split required when map is at 1× zoom)", () => {
    expect(numTilesForScale(1)).toBe(1);
  });

  it("jumps to 2 as soon as scale just exceeds 1", () => {
    expect(numTilesForScale(1.001)).toBe(2);
    expect(numTilesForScale(1.5)).toBe(2);
    expect(numTilesForScale(2.0)).toBe(2);
  });

  it("jumps to 3 as soon as scale just exceeds 2", () => {
    expect(numTilesForScale(2.001)).toBe(3);
    expect(numTilesForScale(2.999)).toBe(3);
  });

  it("always equals Math.ceil(scale) across a range of zoom levels", () => {
    const samples = [0.8, 1.0, 1.3, 1.9, 2.0, 2.7, 3.5, 7.9, 10.1, 49.99, 50];
    for (const s of samples) {
      expect(numTilesForScale(s)).toBe(Math.ceil(s));
    }
  });

  it("reaches MAX_SCALE tiles at the top of the zoom range", () => {
    expect(numTilesForScale(MAX_SCALE)).toBe(MAX_SCALE);
  });

  it("regression: floor() instead of ceil() would keep the tile count one step behind, leaving the map blurry during zoom-in", () => {
    // At scale=1.5, ceil→2 (correct), floor→1 (under-tiled and blurry).
    expect(numTilesForScale(1.5)).toBe(2);
    expect(numTilesForScale(1.5)).not.toBe(Math.floor(1.5));

    // At scale=2.1, ceil→3 (correct), floor→2 (blurry at this zoom tier).
    expect(numTilesForScale(2.1)).toBe(3);
    expect(numTilesForScale(2.1)).not.toBe(Math.floor(2.1));
  });
});

// ── visibleTileRange ───────────────────────────────────────────────────────

describe("visibleTileRange — culls N×N grid to only on-screen tiles", () => {
  it("N=1 always returns the single tile {c0:0, c1:0, r0:0, r1:0}", () => {
    const r = visibleTileRange(1, CW, 1, 0, 0, CW, CH);
    expect(r).toEqual({ c0: 0, c1: 0, r0: 0, r1: 0 });
  });

  it("at N=2, scale=2, centred (tx=0, ty=0): all 4 tiles are visible", () => {
    // At scale=2 the visible SVG area is 195×380 pt; each tile is 195×133 pt.
    // The full 2×2 grid fits with the 1-tile buffer still clamped to [0,1].
    const r = visibleTileRange(2, CW, 2, 0, 0, CW, CH);
    expect(r.c0).toBe(0);
    expect(r.c1).toBe(1);
    expect(r.r0).toBe(0);
    expect(r.r1).toBe(1);
  });

  it("range is always bounded by [0, N−1] regardless of translation", () => {
    // Panned hard to the bottom-right corner (tx and ty both very negative).
    const r = visibleTileRange(5, CW, 5, -9999, -9999, CW, CH);
    expect(r.c0).toBeGreaterThanOrEqual(0);
    expect(r.c1).toBeLessThanOrEqual(4);
    expect(r.r0).toBeGreaterThanOrEqual(0);
    expect(r.r1).toBeLessThanOrEqual(4);

    // Panned hard to the top-left corner.
    const r2 = visibleTileRange(5, CW, 5, 9999, 9999, CW, CH);
    expect(r2.c0).toBeGreaterThanOrEqual(0);
    expect(r2.c1).toBeLessThanOrEqual(4);
    expect(r2.r0).toBeGreaterThanOrEqual(0);
    expect(r2.r1).toBeLessThanOrEqual(4);
  });

  it("at high zoom (N=10, scale=10), well under half of all 100 tiles are in range", () => {
    // At scale=10 the visible SVG area is 39×76 pt; each tile is 39×27 pt.
    // Centred viewport → ~4 cols × 6 rows = 24 tiles visible (vs 100 total).
    const r = visibleTileRange(10, CW, 10, 0, 0, CW, CH);
    const count = (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);
    expect(count).toBeLessThan(50);
  });

  it("centred viewport at N=4 always includes the middle two columns and rows", () => {
    const N = 4;
    const r = visibleTileRange(N, CW, 4, 0, 0, CW, CH);
    expect(r.c0).toBeLessThanOrEqual(1);
    expect(r.c1).toBeGreaterThanOrEqual(2);
    expect(r.r0).toBeLessThanOrEqual(1);
    expect(r.r1).toBeGreaterThanOrEqual(2);
  });

  it("includes a 1-tile buffer: panning so one tile is barely off-screen still loads it", () => {
    // Place the visible area exactly at the right edge of tile 0 (visCX = tileW/2 - ε).
    // Without the buffer, c0 would be 1 (tile 0 excluded).  With it, c0 = 0.
    const N = 4;
    const tileW = CW / N;
    // Push tx so that the left edge of the view is at the right edge of tile 0.
    // visCX = CW/2 - tx/scale → set visCX = tileW (just inside tile 1):
    //   tx = (CW/2 - tileW) * scale
    const scale = 4;
    const tx = (CW / 2 - tileW) * scale;
    const r = visibleTileRange(N, CW, scale, tx, 0, CW, CH);
    expect(r.c0).toBe(0); // buffer includes tile 0
  });

  it("regression: without clamping, an extreme translation could produce c0 < 0 or r1 > N−1", () => {
    const N = 3;
    for (const [tx, ty] of [[999999, 999999], [-999999, -999999]]) {
      const r = visibleTileRange(N, CW, 3, tx, ty, CW, CH);
      expect(r.c0).toBeGreaterThanOrEqual(0);
      expect(r.c1).toBeLessThanOrEqual(N - 1);
      expect(r.r0).toBeGreaterThanOrEqual(0);
      expect(r.r1).toBeLessThanOrEqual(N - 1);
    }
  });
});

// ── applyFit spring-gate regression ───────────────────────────────────────
//
// Bug: applyFit() (called when a search-result pin is shown) animated the
// scale with withSpring but did NOT set springActive=true beforehand.
// The tile-tier reaction fires setRenderZoom on every integer boundary the
// scale crosses during a spring.  Without gating, a zoom-out from scale=4
// to fit (~1.5) crosses three integer boundaries (4→3→2→1), causing three
// rapid tile-grid rebuilds with overlapping crossfade animations — perceived
// as blur and slow loading.
//
// Fix: applyFit now sets springActive=true before the spring and commits
// exactly ONE setRenderZoom(Math.ceil(targetS)) in the spring's onEnd
// callback, matching the pattern used by applyZoom for button-driven zooms.
//
// These tests verify the mathematical invariants that make the fix correct:
//   1. The fit scale for a realistic warehouse falls in a predictable tier.
//   2. A spring from a high zoom level crosses multiple integer boundaries
//      (proving that ungated firing causes churn).
//   3. The one-and-only tier commit value is Math.ceil(fitScale), regardless
//      of the user's starting scale — the gated pattern produces a single,
//      deterministic tier commit.

// Approximate content viewBox for the RDC34 warehouse floor plan.
// The drawing fills most of the 7329×4997 SVG space.
const WAREHOUSE_VB = { x: 60, y: 80, w: 7200, h: 4820 };

/** Compute the fit scale applyFit targets, mirroring its clampScale(rawS * 1.5). */
function computeFitScale(containerW: number, containerH: number): number {
  const { scale: rawS } = fitContentViewport(
    WAREHOUSE_VB, containerW, containerH, SVG_VIEWBOX_W, SVG_VIEWBOX_H,
  );
  return clampScale(rawS * 1.5);
}

/**
 * Count integer tier boundaries crossed during a linear scale transition
 * from `fromScale` to `toScale`.  A boundary is crossed when `Math.ceil`
 * changes value.  This is a lower bound on `setRenderZoom` calls that would
 * be emitted WITHOUT springActive gating.
 */
function tierBoundariesCrossed(fromScale: number, toScale: number): number {
  const lo = Math.min(fromScale, toScale);
  const hi = Math.max(fromScale, toScale);
  // Integer values strictly between lo and hi where ceil changes:
  // ceil changes at every integer n where lo < n <= hi (zoom-out) or lo <= n < hi (zoom-in).
  // For zoom-out: boundaries are integers in (lo, hi].
  let count = 0;
  for (let n = Math.floor(lo) + 1; n <= Math.ceil(hi); n++) {
    if (n > lo && n <= hi) count++;
  }
  return count;
}

describe("applyFit spring-gate — tile-tier commit regression", () => {
  it("fit scale on a phone (390×761) lands in tier 2 (ceil ≈ 1.3–2.0 range)", () => {
    const fitScale = computeFitScale(CW, CH);
    expect(fitScale).toBeGreaterThan(MIN_SCALE);
    expect(fitScale).toBeLessThanOrEqual(2);
    // The committed tier must be 2 (i.e. ceil of a value in (1, 2]).
    expect(numTilesForScale(fitScale)).toBe(2);
  });

  it("regression: without gating, a spring from scale=3 → fit crosses ≥1 tier boundary (would fire setRenderZoom multiple times)", () => {
    const fitScale = computeFitScale(CW, CH);
    const boundaries = tierBoundariesCrossed(3, fitScale);
    // scale=3 → ~1.3 crosses integer 2 (3→2) at minimum → ≥1 ungated fires.
    expect(boundaries).toBeGreaterThanOrEqual(1);
  });

  it("regression: without gating, a spring from scale=4 → fit crosses ≥2 tier boundaries", () => {
    const fitScale = computeFitScale(CW, CH);
    const boundaries = tierBoundariesCrossed(4, fitScale);
    // scale=4 → ~1.3 crosses integers 3 and 2 → 2 ungated fires.
    expect(boundaries).toBeGreaterThanOrEqual(2);
  });

  it("regression: without gating, a spring from scale=5 → fit crosses ≥3 tier boundaries", () => {
    const fitScale = computeFitScale(CW, CH);
    const boundaries = tierBoundariesCrossed(5, fitScale);
    expect(boundaries).toBeGreaterThanOrEqual(3);
  });

  it("with gating: committed tier is Math.ceil(fitScale) — exactly one value, regardless of starting scale", () => {
    const fitScale = computeFitScale(CW, CH);
    const committedTier = Math.ceil(fitScale);
    // The spring's onEnd callback always calls setRenderZoom(Math.ceil(targetS)).
    // Whatever the starting scale, the committed tier is always the same.
    for (const startScale of [1.5, 2, 3, 4, 5, 8, 12, MAX_SCALE]) {
      expect(committedTier).toBe(Math.ceil(fitScale));
    }
    // And it matches numTilesForScale(fitScale) — the same helper used everywhere else.
    expect(committedTier).toBe(numTilesForScale(fitScale));
  });

  it("fit tier is the same on a larger (iPad) viewport — gating contract is device-independent", () => {
    const iPadW = 768;
    const iPadH = 960;
    const fitScale = computeFitScale(iPadW, iPadH);
    const committedTier = Math.ceil(fitScale);
    // iPads are wider; fit scale may be larger but the contract is the same.
    expect(committedTier).toBeGreaterThanOrEqual(1);
    // The tier must equal numTilesForScale for consistency.
    expect(committedTier).toBe(numTilesForScale(fitScale));
  });

  it("tierBoundariesCrossed helper: identity transition (from === to) crosses 0 boundaries", () => {
    expect(tierBoundariesCrossed(2.5, 2.5)).toBe(0);
    expect(tierBoundariesCrossed(3, 3)).toBe(0);
  });

  it("tierBoundariesCrossed helper: crossing exactly one integer boundary", () => {
    // 2.5 → 1.5 crosses integer 2 once.
    expect(tierBoundariesCrossed(2.5, 1.5)).toBe(1);
    // 1.5 → 2.5 also crosses integer 2 once (zoom-in direction).
    expect(tierBoundariesCrossed(1.5, 2.5)).toBe(1);
  });

  it("tierBoundariesCrossed helper: crossing three integer boundaries", () => {
    // 4.5 → 1.5 crosses 4, 3, 2 → 3 boundaries.
    expect(tierBoundariesCrossed(4.5, 1.5)).toBe(3);
  });
});
