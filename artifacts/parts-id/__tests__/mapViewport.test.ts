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
} from "@/utils/mapViewport";

// ── Constants ─────────────────────────────────────────────────────────────────

describe("SVG_VIEWBOX constants", () => {
  it("match the actual floor-plan SVG viewBox (regression: was 3592×2457, causing cropping)", () => {
    // The correct values come from:
    //   curl .../api/floor-plan/svg | grep -oP 'viewBox="[^"]+"' | head -1
    // => viewBox="0 0 7329.6001 4997.2798"
    expect(SVG_VIEWBOX_W).toBeCloseTo(7329.6001, 2);
    expect(SVG_VIEWBOX_H).toBeCloseTo(4997.2798, 2);
  });

  it("aspect ratio matches W/H", () => {
    expect(SVG_ASPECT).toBeCloseTo(SVG_VIEWBOX_W / SVG_VIEWBOX_H, 10);
  });

  it("constants are wider than the old wrong values (regression guard)", () => {
    // The old (wrong) constants were 3592.55 × 2457.41 — roughly half.
    // If someone accidentally halves the constants again, this fails loudly.
    expect(SVG_VIEWBOX_W).toBeGreaterThan(5000);
    expect(SVG_VIEWBOX_H).toBeGreaterThan(3500);
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

  it("regression: old constants (3592×2457) produced large non-zero tx/ty offsets", () => {
    // With wrong constants the contentVB width is 2× the svgVBW reference, so
    // rawScale ≈ 0.45 (clamped up to MIN_SCALE=0.8 by the guard).  More
    // visibly, contentCenterX overshoots svgRenderW/2, producing tx ≈ -162 and
    // ty ≈ -110 — map appears off-centre even after pressing Fit.
    // With correct constants the content centre IS the SVG centre → tx=0, ty=0.
    const WRONG_W = 3592.55, WRONG_H = 2457.41;
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
    expect(Math.abs(wrongTx)).toBeGreaterThan(100);
    expect(Math.abs(wrongTy)).toBeGreaterThan(60);
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

  it("regression: old constants (3592×2457) tiled only the top-left half, missing 75% of the map", () => {
    // With wrong constants, the bottom-right corner of the (1,1) tile was
    // (3592, 2457) instead of (7329, 4997) — the rest of the warehouse was invisible.
    const WRONG_W = 3592.55, WRONG_H = 2457.41;
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
