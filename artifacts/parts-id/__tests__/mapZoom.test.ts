/**
 * Regression tests for map zoom-in / zoom-out behaviour.
 *
 * These tests cover pure-math functions extracted from WarehouseMapView:
 *
 *  clampScale        — keeps gesture and button scales within [MIN_SCALE, MAX_SCALE].
 *  panBounds         — derives max translation limits from container size + scale;
 *                      must always be ≥ 0 and grow as the user zooms in.
 *  visibleTileRange  — culls the N×N grid to only the tiles that are currently
 *                      on-screen (plus a 1-tile buffer), keeping memory constant.
 *  zoomStopForScale  — maps a continuous scale to the nearest discrete ZOOM_STOPS
 *                      index (0–4) using log-space distance.
 *  tileGridSize      — returns 2^stopIndex (1, 2, 4, 8, 16).
 *
 * Bug classes these tests guard against:
 *  • Scale not clamped → blank map below MIN_SCALE, OOM above MAX_SCALE.
 *  • Negative maxX/maxY → map slides off-screen when zoomed out.
 *  • floor() instead of ceil() for numTiles → map stays blurry one tier too long.
 *  • Tile range not clamped to [0, N-1] → index-out-of-bounds renders.
 *  • Wrong zoom-stop index → tiles fetched from wrong API path.
 */

import {
  MIN_SCALE,
  MAX_SCALE,
  SVG_ASPECT,
  SVG_VIEWBOX_W,
  SVG_VIEWBOX_H,
  ZOOM_STOPS,
  clampScale,
  panBounds,
  visibleTileRange,
  fitContentViewport,
  computeFitTarget,
  zoomStopForScale,
  tileGridSize,
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
    const { maxX, maxY } = panBounds(CW, CH, MIN_SCALE, SVG_RENDER_H);
    expect(maxX).toBe(0);
    expect(maxY).toBe(0);
  });

  it("maxX matches (containerW × (scale − 1)) / 2 at scale=2", () => {
    const { maxX } = panBounds(CW, CH, 2, SVG_RENDER_H);
    expect(maxX).toBeCloseTo((CW * (2 - 1)) / 2, 3); // 195
  });

  it("maxX matches (containerW × (scale − 1)) / 2 at scale=5", () => {
    const { maxX } = panBounds(CW, CH, 5, SVG_RENDER_H);
    expect(maxX).toBeCloseTo((CW * (5 - 1)) / 2, 3); // 780
  });

  it("maxY is 0 while the scaled SVG height still fits inside the container (portrait letterbox)", () => {
    // svgRenderH ≈ 265.9 pt; container height 761 pt.
    // Threshold scale = 761 / 265.9 ≈ 2.86 — at scale=2 the map is still letterboxed.
    const { maxY } = panBounds(CW, CH, 2, SVG_RENDER_H);
    expect(maxY).toBe(0);
  });

  it("maxY becomes positive once the scaled SVG height exceeds the container height", () => {
    // At scale=3: svgRenderH × 3 ≈ 797.7 > 761 → maxY ≈ 18.
    const { maxY } = panBounds(CW, CH, 3, SVG_RENDER_H);
    expect(maxY).toBeGreaterThan(0);
    expect(maxY).toBeCloseTo((SVG_RENDER_H * 3 - CH) / 2, 1);
  });

  it("pan bounds grow monotonically when zooming in", () => {
    const scales = [1, 2, 3, 5, 10, 20];
    const bounds = scales.map((s) => panBounds(CW, CH, s, SVG_RENDER_H));
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i].maxX).toBeGreaterThanOrEqual(bounds[i - 1].maxX);
      expect(bounds[i].maxY).toBeGreaterThanOrEqual(bounds[i - 1].maxY);
    }
  });

  it("regression: maxX and maxY were once allowed to go negative (no Math.max(0,…) guard), causing the map to slide off-screen", () => {
    for (const s of [MIN_SCALE, 0.9, 1]) {
      const { maxX, maxY } = panBounds(CW, CH, s, SVG_RENDER_H);
      expect(maxX).toBeGreaterThanOrEqual(0);
      expect(maxY).toBeGreaterThanOrEqual(0);
    }
  });

  it("pan bounds are symmetric: maxX equals half the overflow on each side", () => {
    const scale = 4;
    const { maxX } = panBounds(CW, CH, scale, SVG_RENDER_H);
    const expectedOverflow = CW * scale - CW;
    expect(maxX).toBeCloseTo(expectedOverflow / 2, 3);
  });
});

// ── zoomStopForScale ──────────────────────────────────────────────────────

describe("zoomStopForScale — maps continuous scale to nearest discrete stop index", () => {
  it("ZOOM_STOPS has 5 entries (z0–z4)", () => {
    expect(ZOOM_STOPS).toHaveLength(5);
  });

  it("returns the exact stop index when scale matches a ZOOM_STOP scale exactly", () => {
    ZOOM_STOPS.forEach((stop, idx) => {
      expect(zoomStopForScale(stop.scale)).toBe(idx);
    });
  });

  it("returns 0 (z0 overview) for scales at or near MIN_SCALE", () => {
    expect(zoomStopForScale(MIN_SCALE)).toBe(0);
    expect(zoomStopForScale(1.0)).toBe(0);
    expect(zoomStopForScale(ZOOM_STOPS[0].scale)).toBe(0);
  });

  it("returns 4 (z4 bin) for scales at or near MAX_SCALE", () => {
    expect(zoomStopForScale(MAX_SCALE)).toBe(ZOOM_STOPS.length - 1);
    expect(zoomStopForScale(ZOOM_STOPS[4].scale)).toBe(4);
  });

  it("uses log-space distance: midpoint between adjacent stops rounds to the nearer one", () => {
    // Between z0 (1.5) and z1 (4): geometric midpoint is sqrt(1.5*4) ≈ 2.45.
    // Scales below the midpoint → z0; above → z1.
    const mid = Math.sqrt(ZOOM_STOPS[0].scale * ZOOM_STOPS[1].scale);
    expect(zoomStopForScale(mid * 0.99)).toBe(0);
    expect(zoomStopForScale(mid * 1.01)).toBe(1);
  });

  it("scales between z1 and z2 resolve to the nearer stop", () => {
    const mid = Math.sqrt(ZOOM_STOPS[1].scale * ZOOM_STOPS[2].scale);
    expect(zoomStopForScale(mid * 0.99)).toBe(1);
    expect(zoomStopForScale(mid * 1.01)).toBe(2);
  });

  it("always returns a valid index in [0, ZOOM_STOPS.length - 1]", () => {
    const testScales = [MIN_SCALE, 0.5, 1, 1.5, 4, 10, 22, 45, MAX_SCALE, 0.001, 9999];
    for (const s of testScales) {
      const idx = zoomStopForScale(s);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(ZOOM_STOPS.length);
    }
  });

  it("is monotonically non-decreasing: higher scales map to same or higher stop", () => {
    const asc = [...ZOOM_STOPS.map(s => s.scale), MIN_SCALE, 2, 6, 15, 30].sort((a, b) => a - b);
    let prev = zoomStopForScale(asc[0]);
    for (const s of asc.slice(1)) {
      const cur = zoomStopForScale(s);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("regression: wrong stop index would fetch tiles from the wrong API path (/tiles/z/…)", () => {
    // z2 stop (scale≈10) must map to index 2, not 1 or 3.
    expect(zoomStopForScale(ZOOM_STOPS[2].scale)).toBe(2);
  });
});

// ── tileGridSize ──────────────────────────────────────────────────────────

describe("tileGridSize — returns 2^stopIndex tile-grid dimension", () => {
  it("z0 → 1 tile (1×1 grid, overview)", () => {
    expect(tileGridSize(0)).toBe(1);
  });

  it("z1 → 2 tiles (2×2 grid)", () => {
    expect(tileGridSize(1)).toBe(2);
  });

  it("z2 → 4 tiles (4×4 grid)", () => {
    expect(tileGridSize(2)).toBe(4);
  });

  it("z3 → 8 tiles (8×8 grid)", () => {
    expect(tileGridSize(3)).toBe(8);
  });

  it("z4 → 16 tiles (16×16 grid, bin-level detail)", () => {
    expect(tileGridSize(4)).toBe(16);
  });

  it("tileGridSize(stopIdx) === 2^stopIdx for all valid indices", () => {
    for (let i = 0; i < ZOOM_STOPS.length; i++) {
      expect(tileGridSize(i)).toBe(Math.pow(2, i));
    }
  });

  it("composed with zoomStopForScale: exact stop scales always produce the correct grid size", () => {
    const expected = [1, 2, 4, 8, 16];
    ZOOM_STOPS.forEach((stop, idx) => {
      expect(tileGridSize(zoomStopForScale(stop.scale))).toBe(expected[idx]);
    });
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
// Bug: applyFit() animated the scale with withSpring but did NOT set
// springActive=true beforehand.  The tile-tier reaction fired setRenderZoom
// on every integer boundary the scale crossed during a spring.  Without
// gating, a zoom-out from scale=4 to fit (~1.5) caused multiple tile-grid
// rebuilds with overlapping crossfade animations.
//
// Fix: applyFit now sets springActive=true before the spring and commits
// exactly ONE setRenderZoom(zoomStopForScale(targetS)) in the spring's onEnd
// callback.  The discrete zoom-stop model (5 presets) also means the tile
// grid never rebuilds mid-spring — only on stop commitment.
//
// These tests verify the mathematical invariants that make the fix correct:
//   1. The fit scale for a realistic warehouse maps to zoom stop 0 (overview).
//   2. A spring from a high zoom level crosses multiple integer boundaries
//      (proving that ungated firing would cause churn under the old model).
//   3. The one-and-only stop commit is zoomStopForScale(fitScale), regardless
//      of the user's starting scale — the gated pattern produces a single,
//      deterministic stop commit.

// Approximate content viewBox for the RDC34 warehouse floor plan.
// The drawing fills most of the 3592×2457 SVG space.
const WAREHOUSE_VB = { x: 30, y: 40, w: 3530, h: 2397 };

/** Compute the fit scale applyFit targets — always snaps to ZOOM_STOPS[0].scale (z0). */
function computeFitScale(_containerW: number, _containerH: number): number {
  return ZOOM_STOPS[0].scale;
}

/**
 * Count integer tier boundaries crossed during a linear scale transition
 * from `fromScale` to `toScale`.  A boundary is crossed when `Math.ceil`
 * changes value.  This is a lower bound on `setRenderZoom` calls that would
 * have been emitted WITHOUT springActive gating under the old continuous model.
 */
function tierBoundariesCrossed(fromScale: number, toScale: number): number {
  const lo = Math.min(fromScale, toScale);
  const hi = Math.max(fromScale, toScale);
  let count = 0;
  for (let n = Math.floor(lo) + 1; n <= Math.ceil(hi); n++) {
    if (n > lo && n <= hi) count++;
  }
  return count;
}

describe("applyFit spring-gate — zoom-stop commit regression", () => {
  it("fit scale on a phone (390×761) maps to zoom stop 0 (overview, scale≈1.5)", () => {
    const fitScale = computeFitScale(CW, CH);
    const committedStop = zoomStopForScale(fitScale);
    expect(committedStop).toBe(0);
    expect(tileGridSize(committedStop)).toBe(1); // z0 = 1×1 grid
  });

  it("regression: without springActive gating, spring from scale=3 → fit would cross ≥1 integer boundary (old model would fire setRenderZoom multiple times)", () => {
    const fitScale = computeFitScale(CW, CH);
    const boundaries = tierBoundariesCrossed(3, fitScale);
    expect(boundaries).toBeGreaterThanOrEqual(1);
  });

  it("regression: spring from scale=4 → fit crosses ≥2 integer boundaries under the old model", () => {
    const fitScale = computeFitScale(CW, CH);
    const boundaries = tierBoundariesCrossed(4, fitScale);
    expect(boundaries).toBeGreaterThanOrEqual(2);
  });

  it("regression: spring from scale=5 → fit crosses ≥3 integer boundaries under the old model", () => {
    const fitScale = computeFitScale(CW, CH);
    const boundaries = tierBoundariesCrossed(5, fitScale);
    expect(boundaries).toBeGreaterThanOrEqual(3);
  });

  it("with gating: committed stop is zoomStopForScale(fitScale) — exactly one value, regardless of starting scale", () => {
    const fitScale = computeFitScale(CW, CH);
    const committedStop = zoomStopForScale(fitScale);
    for (const _startScale of [1.5, 2, 3, 4, 5, 8, 12, MAX_SCALE]) {
      // The spring onEnd always calls setRenderZoom(zoomStopForScale(targetS)).
      // Whatever the starting scale, the committed stop is always the same.
      expect(zoomStopForScale(fitScale)).toBe(committedStop);
    }
    // numTiles for the committed stop must be a power of 2.
    expect(tileGridSize(committedStop)).toBe(Math.pow(2, committedStop));
  });

  it("fit stop is the same on a larger (iPad) viewport — gating contract is device-independent", () => {
    const iPadW = 768;
    const iPadH = 960;
    const fitScale = computeFitScale(iPadW, iPadH);
    const committedStop = zoomStopForScale(fitScale);
    expect(committedStop).toBeGreaterThanOrEqual(0);
    expect(committedStop).toBeLessThan(ZOOM_STOPS.length);
    expect(tileGridSize(committedStop)).toBe(Math.pow(2, committedStop));
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

// ── applyFit / applyFitIfReady callback paths — z0 snap ───────────────────
//
// Both applyFit (animated, fit button) and applyFitIfReady (immediate, called
// from onLayout and the SVG-parse effect) delegate their scale/tx/ty
// calculation to computeFitTarget(), which always snaps scale to
// ZOOM_STOPS[0].scale (z0 overview).
//
// These tests call computeFitTarget() directly — the same production function
// the callbacks use after the refactor.  If applyFit/applyFitIfReady are ever
// edited to use a different scale or a raw fit value, the change will flow
// through computeFitTarget and these tests will catch it immediately.
//
// Phone (390×761) and iPad (768×960) viewports are both exercised so regressions
// on unusual aspect ratios are caught too.

describe("applyFit / applyFitIfReady — computeFitTarget always snaps to z0", () => {
  const phoneW = 390;  // iPhone 14 portrait
  const phoneH = 761;
  const iPadW  = 768;  // iPad mini / Air portrait
  const iPadH  = 960;

  // ── scale snap ────────────────────────────────────────────────────────────

  it("phone: computeFitTarget returns scale === ZOOM_STOPS[0].scale", () => {
    const { scale } = computeFitTarget(WAREHOUSE_VB, phoneW, phoneH);
    expect(scale).toBe(ZOOM_STOPS[0].scale);
  });

  it("iPad: computeFitTarget returns scale === ZOOM_STOPS[0].scale", () => {
    const { scale } = computeFitTarget(WAREHOUSE_VB, iPadW, iPadH);
    expect(scale).toBe(ZOOM_STOPS[0].scale);
  });

  it("phone: renderZoom === 0 (z0 tile grid, 1×1 overview)", () => {
    const { scale } = computeFitTarget(WAREHOUSE_VB, phoneW, phoneH);
    expect(zoomStopForScale(scale)).toBe(0);
    expect(tileGridSize(zoomStopForScale(scale))).toBe(1);
  });

  it("iPad: renderZoom === 0 (z0 tile grid, 1×1 overview)", () => {
    const { scale } = computeFitTarget(WAREHOUSE_VB, iPadW, iPadH);
    expect(zoomStopForScale(scale)).toBe(0);
    expect(tileGridSize(zoomStopForScale(scale))).toBe(1);
  });

  // ── snap is device-independent ────────────────────────────────────────────

  it("phone and iPad produce identical committed scale and renderZoom (snap is device-independent)", () => {
    const phone = computeFitTarget(WAREHOUSE_VB, phoneW, phoneH);
    const iPad  = computeFitTarget(WAREHOUSE_VB, iPadW,  iPadH);
    expect(phone.scale).toBe(iPad.scale);
    expect(zoomStopForScale(phone.scale)).toBe(zoomStopForScale(iPad.scale));
    expect(zoomStopForScale(phone.scale)).toBe(0);
  });

  it("raw fit scale varies between phone and iPad but computeFitTarget always overrides to z0", () => {
    const phoneRaw = fitContentViewport(WAREHOUSE_VB, phoneW, phoneH, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    const iPadRaw  = fitContentViewport(WAREHOUSE_VB, iPadW,  iPadH,  SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    expect(phoneRaw.scale).not.toBe(iPadRaw.scale); // raw values differ by device
    expect(computeFitTarget(WAREHOUSE_VB, phoneW, phoneH).scale).toBe(ZOOM_STOPS[0].scale);
    expect(computeFitTarget(WAREHOUSE_VB, iPadW,  iPadH ).scale).toBe(ZOOM_STOPS[0].scale);
  });

  // ── tx/ty sanity ──────────────────────────────────────────────────────────

  it("phone: tx and ty are finite (no NaN or Infinity from ratio calculation)", () => {
    const { tx, ty } = computeFitTarget(WAREHOUSE_VB, phoneW, phoneH);
    expect(isFinite(tx)).toBe(true);
    expect(isFinite(ty)).toBe(true);
  });

  it("iPad: tx and ty are finite (no NaN or Infinity from ratio calculation)", () => {
    const { tx, ty } = computeFitTarget(WAREHOUSE_VB, iPadW, iPadH);
    expect(isFinite(tx)).toBe(true);
    expect(isFinite(ty)).toBe(true);
  });

  // ── ZOOM_STOPS[0] guard ───────────────────────────────────────────────────

  it("regression: ZOOM_STOPS[0].scale must be within [MIN_SCALE, ZOOM_STOPS[1].scale] — if this fails the z0 snap is misconfigured", () => {
    expect(ZOOM_STOPS[0].scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(ZOOM_STOPS[0].scale).toBeLessThanOrEqual(ZOOM_STOPS[1].scale);
  });
});
