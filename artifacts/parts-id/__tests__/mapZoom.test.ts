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
  clampScale,
  panBounds,
  numTilesForScale,
  visibleTileRange,
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
