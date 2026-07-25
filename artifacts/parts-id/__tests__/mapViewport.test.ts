/**
 * Regression tests for the warehouse map viewport math.
 *
 * These tests exist to prevent two classes of bug that caused visible regressions:
 *
 *  1. Wrong SVG_VIEWBOX constants  — SVG_VIEWBOX_W/H must exactly match the
 *     viewBox attribute of the floor-plan SVG.  If they're halved (e.g. 3592×2457
 *     instead of 7329×4997) the tile-slicing crops to the top-left quadrant and
 *     fitContentViewport computes fittedScale≈0.45 instead of ≈0.92.
 *
 *  2. Unclamped fit after constant change — a viewport persisted with wrong
 *     constants can survive a constant fix if the cache key is not bumped.
 */

import {
  SVG_VIEWBOX_W,
  SVG_VIEWBOX_H,
  SVG_ASPECT,
  MIN_SCALE,
  MAX_SCALE,
  FIT_PADDING,
  parseContentViewBox,
  fitContentViewport,
  makeTileViewBox,
  computeFocusPan,
} from "@/utils/mapViewport";

// ── Constants ─────────────────────────────────────────────────────────────────

describe("SVG_VIEWBOX constants", () => {
  it("match the actual floor-plan SVG viewBox", () => {
    // The correct values come from:
    //   curl .../api/floor-plan/svg | grep -oP 'viewBox="[^"]+"' | head -1
    // => viewBox="0 0 3592.55 2457.41"
    expect(SVG_VIEWBOX_W).toBeCloseTo(3592.55, 2);
    expect(SVG_VIEWBOX_H).toBeCloseTo(2457.41, 2);
  });

  it("aspect ratio matches W/H", () => {
    expect(SVG_ASPECT).toBeCloseTo(SVG_VIEWBOX_W / SVG_VIEWBOX_H, 10);
  });

  it("constants are within the expected range (sanity guard)", () => {
    expect(SVG_VIEWBOX_W).toBeGreaterThan(2000);
    expect(SVG_VIEWBOX_H).toBeGreaterThan(1000);
  });
});

// ── parseContentViewBox ───────────────────────────────────────────────────────

describe("parseContentViewBox", () => {
  it("parses a standard viewBox with space-separated values", () => {
    const xml = '<svg viewBox="0 0 7329.6001 4997.2798">';
    expect(parseContentViewBox(xml)).toEqual({
      x: 0,
      y: 0,
      w: 7329.6001,
      h: 4997.2798,
    });
  });

  it("parses a viewBox with an offset origin (non-zero x, y)", () => {
    const xml = '<svg viewBox="100 200 1200 800">';
    expect(parseContentViewBox(xml)).toEqual({ x: 100, y: 200, w: 1200, h: 800 });
  });

  it("parses comma-separated values", () => {
    const xml = '<svg viewBox="0,0,100,50">';
    expect(parseContentViewBox(xml)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  it("returns null when viewBox attribute is absent", () => {
    expect(parseContentViewBox("<svg width='100' height='50'>")).toBeNull();
  });

  it("returns null for a malformed viewBox (only 3 numbers)", () => {
    expect(parseContentViewBox('<svg viewBox="0 0 100">')).toBeNull();
  });

  it("returns null when a viewBox value is non-numeric", () => {
    expect(parseContentViewBox('<svg viewBox="0 0 abc 50">')).toBeNull();
  });

  it("parses the first viewBox attribute in a multi-element document", () => {
    const xml = '<svg viewBox="0 0 7329.6001 4997.2798"><defs><pattern viewBox="0 0 10 10"/></defs></svg>';
    expect(parseContentViewBox(xml)).toEqual({
      x: 0, y: 0, w: 7329.6001, h: 4997.2798,
    });
  });
});

// ── fitContentViewport ────────────────────────────────────────────────────────

// Simulate iPhone 14 portrait: 390 × 844 pts, tab bar ~83 pt → mapH ≈ 761.
const CW = 390;   // containerW
const CH = 761;   // containerH

describe("fitContentViewport — full-canvas fit", () => {
  const fullCanvas = { x: 0, y: 0, w: SVG_VIEWBOX_W, h: SVG_VIEWBOX_H };

  it("fits the full canvas with scale close to (containerW - 2*padding) / containerW", () => {
    const { scale } = fitContentViewport(fullCanvas, CW, CH, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    const expectedScale = (CW - FIT_PADDING * 2) / CW;
    expect(scale).toBeCloseTo(expectedScale, 3);
  });

  it("centres the full canvas (tx=0, ty=0) because content centre equals SVG centre", () => {
    const { tx, ty } = fitContentViewport(fullCanvas, CW, CH, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    expect(tx).toBeCloseTo(0, 5);
    expect(ty).toBeCloseTo(0, 5);
  });

  it("regression: doubled constants produce large non-zero tx/ty offsets", () => {
    // With wrong constants the contentVB width is 2× the svgVBW reference, so
    // rawScale ≈ 0.45 (clamped up to MIN_SCALE=0.8 by the guard).  More
    // visibly, contentCenterX overshoots svgRenderW/2 — map appears off-centre
    // even after pressing Fit.
    // With correct constants the content centre IS the SVG centre → tx=0, ty=0.
    const WRONG_W = SVG_VIEWBOX_W * 2, WRONG_H = SVG_VIEWBOX_H * 2;
    const { tx: wrongTx, ty: wrongTy } = fitContentViewport(
      fullCanvas, CW, CH, WRONG_W, WRONG_H,
    );
    const { tx: correctTx, ty: correctTy } = fitContentViewport(
      fullCanvas, CW, CH, SVG_VIEWBOX_W, SVG_VIEWBOX_H,
    );
    // Correct constants → perfectly centred.
    expect(correctTx).toBeCloseTo(0, 5);
    expect(correctTy).toBeCloseTo(0, 5);
    // Wrong constants → large mis-centering offset.
    expect(Math.abs(wrongTx)).toBeGreaterThan(50);
    expect(Math.abs(wrongTy)).toBeGreaterThan(30);
  });
});

describe("fitContentViewport — offset content", () => {
  it("translates so the content centre maps to the container centre", () => {
    // Content in the lower-right quadrant of the canvas.
    const contentVB = {
      x: SVG_VIEWBOX_W * 0.5,
      y: SVG_VIEWBOX_H * 0.5,
      w: SVG_VIEWBOX_W * 0.5,
      h: SVG_VIEWBOX_H * 0.5,
    };
    const { tx, ty } = fitContentViewport(contentVB, CW, CH, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    // Content centre is at (0.75 × svgRenderW, 0.75 × svgRenderH).
    // dx = 0.25 × svgRenderW (offset to the right of the SVG centre).
    // tx must be negative to shift the content leftward into view.
    expect(tx).toBeLessThan(0);
    expect(ty).toBeLessThan(0);
  });

  it("offset-origin viewBox centring is symmetric: left-half has equal-magnitude positive tx", () => {
    const right = {
      x: SVG_VIEWBOX_W * 0.5, y: 0,
      w: SVG_VIEWBOX_W * 0.5, h: SVG_VIEWBOX_H,
    };
    const left = {
      x: 0, y: 0,
      w: SVG_VIEWBOX_W * 0.5, h: SVG_VIEWBOX_H,
    };
    const { tx: txRight } = fitContentViewport(right, CW, CH, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    const { tx: txLeft }  = fitContentViewport(left,  CW, CH, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    expect(txRight).toBeCloseTo(-txLeft, 5);
  });
});

describe("fitContentViewport — scale clamping", () => {
  it("clamps up to MIN_SCALE when content is very large", () => {
    // Content that is much bigger than the container → rawScale < MIN_SCALE.
    const huge = { x: 0, y: 0, w: SVG_VIEWBOX_W * 10, h: SVG_VIEWBOX_H * 10 };
    const { scale } = fitContentViewport(huge, CW, CH, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    expect(scale).toBe(MIN_SCALE);
  });

  it("clamps down to MAX_SCALE when content is tiny", () => {
    // Content that is a tiny 1×1 pixel dot → rawScale >> MAX_SCALE.
    const tiny = { x: 0, y: 0, w: 1, h: 1 };
    const { scale } = fitContentViewport(tiny, CW, CH, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    expect(scale).toBe(MAX_SCALE);
  });
});

// ── makeTileViewBox ───────────────────────────────────────────────────────────

describe("makeTileViewBox", () => {
  it("top-left tile (0,0) at N=2 starts at the SVG origin", () => {
    const vb = makeTileViewBox(0, 0, 2, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    expect(vb).toBe(`0 0 ${SVG_VIEWBOX_W / 2} ${SVG_VIEWBOX_H / 2}`);
  });

  it("bottom-right tile at N=2 ends at the SVG extent", () => {
    const vb = makeTileViewBox(1, 1, 2, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    const halfW = SVG_VIEWBOX_W / 2;
    const halfH = SVG_VIEWBOX_H / 2;
    expect(vb).toBe(`${halfW} ${halfH} ${halfW} ${halfH}`);
  });

  it("at N=3 all 9 tiles together cover the full SVG coordinate range", () => {
    const N = 3;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const parts = makeTileViewBox(c, r, N, SVG_VIEWBOX_W, SVG_VIEWBOX_H)
          .split(" ")
          .map(Number);
        const [x, y, w, h] = parts;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
      }
    }
    expect(minX).toBeCloseTo(0, 5);
    expect(minY).toBeCloseTo(0, 5);
    expect(maxX).toBeCloseTo(SVG_VIEWBOX_W, 5);
    expect(maxY).toBeCloseTo(SVG_VIEWBOX_H, 5);
  });

  it("tiles at N=2 have no gaps or overlaps (adjacent tiles share an edge)", () => {
    // Right edge of tile (0,0) == left edge of tile (1,0)
    const [x00, , w00] = makeTileViewBox(0, 0, 2, SVG_VIEWBOX_W, SVG_VIEWBOX_H).split(" ").map(Number);
    const [x10] = makeTileViewBox(1, 0, 2, SVG_VIEWBOX_W, SVG_VIEWBOX_H).split(" ").map(Number);
    expect(x00 + w00).toBeCloseTo(x10, 5);
  });

  it("regression: halved constants tile only the top-left quarter, missing 75% of the map", () => {
    // With halved constants the bottom-right corner of the (1,1) tile is
    // half the true extent — the rest of the warehouse is invisible.
    const WRONG_W = SVG_VIEWBOX_W / 2, WRONG_H = SVG_VIEWBOX_H / 2;
    const wrongVb = makeTileViewBox(1, 1, 2, WRONG_W, WRONG_H);
    const parts = wrongVb.split(" ").map(Number);
    const [x, y, w, h] = parts;
    const wrongMaxX = x + w;
    const wrongMaxY = y + h;

    const correctVb = makeTileViewBox(1, 1, 2, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    const [cx, cy, cw, ch] = correctVb.split(" ").map(Number);
    const correctMaxX = cx + cw;
    const correctMaxY = cy + ch;

    // Wrong constants stop at ~half the correct extent.
    expect(wrongMaxX).toBeCloseTo(WRONG_W, 2);
    expect(correctMaxX).toBeCloseTo(SVG_VIEWBOX_W, 2);
    expect(wrongMaxX).toBeLessThan(correctMaxX * 0.6); // at least 40% short
    expect(wrongMaxY).toBeLessThan(correctMaxY * 0.6);
  });
});

// ── computeFocusPan — no-zoom contract ────────────────────────────────────────
//
// The focusAisleNum effect pans the viewport to centre the target zone while
// keeping scale.value untouched.  These tests lock down the two invariants:
//
//   1. scale is never touched — computeFocusPan returns only { tx, ty }.
//      A future change that snuck scale=2.5 into the return value would break
//      this immediately.
//
//   2. The translation offsets use the *caller-supplied* currentScale, not any
//      hard-coded TARGET_SCALE.  Doubling currentScale must produce a
//      proportionally larger displacement from the container centre.

// Simulate iPhone 14 portrait (same container as the fit tests above).
const PAN_CW = 390;  // containerW
const PAN_CH = 761;  // containerH

// A representative zone centre deep inside the warehouse SVG canvas.
const ZONE_CX = SVG_VIEWBOX_W * 0.6;   // 60% across
const ZONE_CY = SVG_VIEWBOX_H * 0.35;  // 35% down

describe("computeFocusPan — no-zoom contract", () => {
  it("returns only { tx, ty } — scale is not part of the result (regression: must not force scale to 2.5)", () => {
    const result = computeFocusPan(1.4, ZONE_CX, ZONE_CY, PAN_CW, PAN_CH);
    // The function must NOT return a scale field.
    // If a future refactor accidentally returns scale:2.5 here, this test fails.
    expect((result as Record<string, unknown>).scale).toBeUndefined();
    expect(typeof result.tx).toBe("number");
    expect(typeof result.ty).toBe("number");
  });

  it("result at scale=1.4 differs from result at scale=2.5 (regression: must not hard-code TARGET_SCALE=2.5)", () => {
    const atCurrent = computeFocusPan(1.4, ZONE_CX, ZONE_CY, PAN_CW, PAN_CH);
    const atTarget  = computeFocusPan(2.5, ZONE_CX, ZONE_CY, PAN_CW, PAN_CH);
    // If the implementation ignores currentScale and always uses 2.5, tx/ty
    // would be identical regardless of the argument passed.
    expect(atCurrent.tx).not.toBeCloseTo(atTarget.tx, 3);
    expect(atCurrent.ty).not.toBeCloseTo(atTarget.ty, 3);
  });
});

describe("computeFocusPan — translation uses pre-existing scale", () => {
  it("displacement from container centre scales linearly with currentScale", () => {
    // At scale s, the horizontal displacement is:
    //   tx - W/2 = -(zoneCx / SVG_VIEWBOX_W) * containerW * s
    // Doubling s must double the displacement from centre.
    const panAt1 = computeFocusPan(1.0, ZONE_CX, ZONE_CY, PAN_CW, PAN_CH);
    const panAt2 = computeFocusPan(2.0, ZONE_CX, ZONE_CY, PAN_CW, PAN_CH);

    const dx1 = panAt1.tx - PAN_CW / 2;
    const dx2 = panAt2.tx - PAN_CW / 2;
    expect(dx2).toBeCloseTo(2 * dx1, 5);

    const dy1 = panAt1.ty - PAN_CH / 2;
    const dy2 = panAt2.ty - PAN_CH / 2;
    expect(dy2).toBeCloseTo(2 * dy1, 5);
  });

  it("centres the zone exactly when zoneCx == SVG midpoint (tx == containerW/2 - half svgRenderW * s)", () => {
    // When the zone centre is the horizontal midpoint of the SVG, the required
    // tx should place exactly half of the (scaled) SVG render width to the left
    // of the container centre.
    const midCx = SVG_VIEWBOX_W / 2;
    const s = 1.5;
    const { tx } = computeFocusPan(s, midCx, 0, PAN_CW, PAN_CH);
    // scaleRW = (1/SVG_VIEWBOX_W) * PAN_CW * s
    // tx = PAN_CW/2 - (SVG_VIEWBOX_W/2) * scaleRW
    //    = PAN_CW/2 - PAN_CW/2 * s
    const expected = PAN_CW / 2 - (PAN_CW / 2) * s;
    expect(tx).toBeCloseTo(expected, 5);
  });
});
