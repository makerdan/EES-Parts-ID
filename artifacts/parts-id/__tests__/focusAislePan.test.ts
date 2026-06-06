/**
 * Regression tests for the focusAisleNum pan-without-zoom contract.
 *
 * The `runFocusAisleEffect` handler is extracted from the `focusAisleNum`
 * useEffect in WarehouseMapView so the core invariants can be verified
 * directly — no React, Reanimated, or component mounting required.
 *
 * Two classes of regression are guarded:
 *
 *  1. Zoom regression — scale must never be modified by the focus effect.
 *     The function receives `currentScale` as a plain number and must NOT
 *     return a `scale` field.  If someone reintroduces `scale: 2.5` in the
 *     return value (or mutates a shared value), these tests fail immediately.
 *
 *  2. Hard-coded TARGET_SCALE regression — translations must be computed
 *     from the caller-supplied `currentScale`, not from a constant.
 *     Calling the function with scale=1.7 vs scale=2.5 must produce
 *     different pan offsets.
 */

import { runFocusAisleEffect } from "@/utils/mapViewport";

// ─── No mocks needed ─────────────────────────────────────────────────────────
// runFocusAisleEffect is a pure function: it takes plain numbers, calls
// computeFocusPan (also pure), and returns { tx, ty } | null.
// No React, Reanimated, or React Native dependencies are imported.

// ── Fixtures ─────────────────────────────────────────────────────────────────

// iPhone 14 portrait (same container as the mapViewport suite).
const CW = 390;   // containerW
const CH = 761;   // containerH

// A zone that is well outside the initial (identity) viewport so the
// visibility guard does NOT short-circuit the pan logic.
const OUT_OF_VIEW_ZONE = {
  aisleId: "5",
  sectionNum: 1,
  svgX:    5200,
  svgY:    3500,
  svgWidth:  200,
  svgHeight: 300,
};

const BASE_OPTS = {
  focusAisleNum: 5,
  zones: [OUT_OF_VIEW_ZONE],
  containerW: CW,
  containerH: CH,
  currentTX: 0,
  currentTY: 0,
};

// =============================================================================
// 1. No-zoom contract
// =============================================================================

describe("runFocusAisleEffect — no-zoom contract", () => {
  it("returns only { tx, ty } — no scale field (regression: must not force scale to 2.5)", () => {
    const result = runFocusAisleEffect({ ...BASE_OPTS, currentScale: 1.7 });

    // Pan must have fired (zone is clearly out of the viewport).
    expect(result).not.toBeNull();
    expect(typeof result!.tx).toBe("number");
    expect(typeof result!.ty).toBe("number");

    // The critical assertion: the result must not contain a scale field.
    // If a future refactor returns { tx, ty, scale: 2.5 }, this test fails.
    expect((result as Record<string, unknown>).scale).toBeUndefined();
  });

  it("result with scale=1.7 differs from result with scale=2.5 (must not hard-code TARGET_SCALE)", () => {
    const at1_7 = runFocusAisleEffect({ ...BASE_OPTS, currentScale: 1.7 });
    const at2_5 = runFocusAisleEffect({ ...BASE_OPTS, currentScale: 2.5 });

    expect(at1_7).not.toBeNull();
    expect(at2_5).not.toBeNull();

    // If the implementation ignored currentScale and used a hard-coded constant
    // (e.g. the old TARGET_SCALE = 2.5), both calls would return identical offsets.
    expect(at1_7!.tx).not.toBeCloseTo(at2_5!.tx, 3);
    expect(at1_7!.ty).not.toBeCloseTo(at2_5!.ty, 3);
  });
});

// =============================================================================
// 2. Translation uses currentScale (not a constant)
// =============================================================================

describe("runFocusAisleEffect — translation is proportional to currentScale", () => {
  it("displacement from container centre scales linearly with currentScale", () => {
    // At scale s: tx - CW/2 = -zoneCx * (CW / SVG_VIEWBOX_W) * s  (from computeFocusPan).
    // Doubling s must double the displacement from centre.
    //
    // The SVG viewBox is ~7330 × ~4997 px.  At scale=1 the entire map fits in
    // the 390×761 container, so every in-SVG zone is already visible — the
    // function returns null.  We must use a scale where the zone at svgX=5200
    // is genuinely off-screen (zoneL > containerW):
    //   scale=2.0  →  zoneL ≈ 554 px  > 390 → out of view ✓
    //   scale=4.0  →  zoneL ≈ 1108 px > 390 → out of view ✓
    const atS2 = runFocusAisleEffect({ ...BASE_OPTS, currentScale: 2.0 });
    const atS4 = runFocusAisleEffect({ ...BASE_OPTS, currentScale: 4.0 });

    expect(atS2).not.toBeNull();
    expect(atS4).not.toBeNull();

    const dx2 = atS2!.tx - CW / 2;
    const dx4 = atS4!.tx - CW / 2;
    expect(dx4).toBeCloseTo(2 * dx2, 5);

    const dy2 = atS2!.ty - CH / 2;
    const dy4 = atS4!.ty - CH / 2;
    expect(dy4).toBeCloseTo(2 * dy2, 5);
  });
});

// =============================================================================
// 3. Edge cases — guard against silent early returns
// =============================================================================

describe("runFocusAisleEffect — edge-case returns", () => {
  it("returns null when containerW is 0 (layout not yet fired)", () => {
    const result = runFocusAisleEffect({
      ...BASE_OPTS,
      containerW: 0,
      currentScale: 1.7,
    });
    expect(result).toBeNull();
  });

  it("returns null when the focusAisleNum does not match any zone", () => {
    const result = runFocusAisleEffect({
      ...BASE_OPTS,
      focusAisleNum: 999,
      currentScale: 1.7,
    });
    expect(result).toBeNull();
  });

  it("returns null when the target zone is already fully visible", () => {
    // At scale=1 and tx=ty=0, a zone near the SVG origin is visible because
    // the entire SVG fits inside the container at the identity transform.
    // Place the zone at (0,0) so it's definitely in view.
    const result = runFocusAisleEffect({
      focusAisleNum: 1,
      zones: [{ aisleId: "1", sectionNum: 1, svgX: 0, svgY: 0, svgWidth: 10, svgHeight: 10 }],
      containerW: CW,
      containerH: CH,
      currentScale: 1,
      currentTX: 0,
      currentTY: 0,
    });
    // Zone is at the SVG origin → always visible at identity transform → no pan.
    expect(result).toBeNull();
  });

  it("centres on the matching section zone when focusSectionNum is provided", () => {
    const sectionTwo = {
      aisleId: "5",
      sectionNum: 2,
      svgX: 4800,
      svgY: 3500,
      svgWidth: 100,
      svgHeight: 50,
    };
    const sectionTen = {
      aisleId: "5",
      sectionNum: 10,
      svgX: 5200,
      svgY: 3500,
      svgWidth: 100,
      svgHeight: 50,
    };
    const zonesWithTwoSections = [sectionTwo, sectionTen];

    // Without focusSectionNum — should pick the first zone (sectionNum=2)
    const withoutSection = runFocusAisleEffect({
      focusAisleNum: 5,
      zones: zonesWithTwoSections,
      containerW: CW,
      containerH: CH,
      currentScale: 2.0,
      currentTX: 0,
      currentTY: 0,
    });

    // With focusSectionNum=10 — should centre on the sectionNum=10 zone
    const withSection = runFocusAisleEffect({
      focusAisleNum: 5,
      focusSectionNum: 10,
      zones: zonesWithTwoSections,
      containerW: CW,
      containerH: CH,
      currentScale: 2.0,
      currentTX: 0,
      currentTY: 0,
    });

    expect(withoutSection).not.toBeNull();
    expect(withSection).not.toBeNull();
    // The two zones are at different svgX positions, so their pan targets must differ.
    expect(withoutSection!.tx).not.toBeCloseTo(withSection!.tx, 3);
  });

  it("falls back to the first aisle zone when focusSectionNum matches nothing", () => {
    const zonesWithTwoSections = [
      { aisleId: "5", sectionNum: 2, svgX: 4800, svgY: 3500, svgWidth: 100, svgHeight: 50 },
      { aisleId: "5", sectionNum: 10, svgX: 5200, svgY: 3500, svgWidth: 100, svgHeight: 50 },
    ];

    const withMissingSection = runFocusAisleEffect({
      focusAisleNum: 5,
      focusSectionNum: 99,
      zones: zonesWithTwoSections,
      containerW: CW,
      containerH: CH,
      currentScale: 2.0,
      currentTX: 0,
      currentTY: 0,
    });

    const withFirstSection = runFocusAisleEffect({
      focusAisleNum: 5,
      focusSectionNum: 2,
      zones: zonesWithTwoSections,
      containerW: CW,
      containerH: CH,
      currentScale: 2.0,
      currentTX: 0,
      currentTY: 0,
    });

    // Both should return a valid pan target
    expect(withMissingSection).not.toBeNull();
    expect(withFirstSection).not.toBeNull();
    // Falling back to first zone (sectionNum=2) means same result as explicitly asking for it.
    expect(withMissingSection!.tx).toBeCloseTo(withFirstSection!.tx, 3);
    expect(withMissingSection!.ty).toBeCloseTo(withFirstSection!.ty, 3);
  });
});
