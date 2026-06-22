import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import {
  computeWheelZoom,
  ZOOM_IN_FACTOR,
  ZOOM_OUT_FACTOR,
  MIN_SCALE,
  MAX_SCALE,
  type Tf,
} from "../utils/wheelZoom";
import { ZoneEditor } from "../pages/ZoneEditor";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getTransformGroup(container: HTMLElement): SVGGElement {
  const g = container.querySelector("svg > g") as SVGGElement | null;
  if (!g) throw new Error("Could not find the zoom <g> inside the SVG canvas");
  return g;
}

function parseScale(transform: string): number {
  const m = transform.match(/scale\(([^)]+)\)/);
  if (!m) throw new Error(`No scale() found in transform: "${transform}"`);
  return parseFloat(m[1]!);
}

function getSvgElement(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg") as SVGSVGElement | null;
  if (!svg) throw new Error("Could not find the SVG canvas element");
  return svg;
}

function makeWheelEvent(deltaY: number, opts: Partial<WheelEventInit> = {}): WheelEvent {
  return new WheelEvent("wheel", {
    deltaY,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
}

// ── Pure math tests ────────────────────────────────────────────────────────────

describe("computeWheelZoom — pure transform math", () => {
  const baseTf: Tf = { x: 0, y: 0, s: 1 };

  describe("zoom-in (deltaY < 0)", () => {
    it("increases the scale by ZOOM_IN_FACTOR", () => {
      const result = computeWheelZoom(baseTf, 0, 0, -1);
      expect(result.s).toBeCloseTo(ZOOM_IN_FACTOR);
    });

    it("keeps the cursor point fixed in SVG space (origin cursor)", () => {
      const result = computeWheelZoom(baseTf, 0, 0, -1);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(0);
    });

    it("keeps the cursor point fixed in SVG space (non-origin cursor)", () => {
      const curr: Tf = { x: 10, y: 20, s: 2 };
      const mx = 100;
      const my = 200;
      const result = computeWheelZoom(curr, mx, my, -1);
      const svgX = (mx - curr.x) / curr.s;
      const svgY = (my - curr.y) / curr.s;
      expect(result.x).toBeCloseTo(mx - svgX * result.s);
      expect(result.y).toBeCloseTo(my - svgY * result.s);
    });

    it("produces the correct absolute transform values for known inputs", () => {
      const curr: Tf = { x: 0, y: 0, s: 1 };
      const result = computeWheelZoom(curr, 200, 150, -100);
      const expectedS = ZOOM_IN_FACTOR;
      expect(result.s).toBeCloseTo(expectedS);
      expect(result.x).toBeCloseTo(200 - 200 * expectedS);
      expect(result.y).toBeCloseTo(150 - 150 * expectedS);
    });
  });

  describe("zoom-out (deltaY > 0)", () => {
    it("decreases the scale by ZOOM_OUT_FACTOR", () => {
      const result = computeWheelZoom(baseTf, 0, 0, 1);
      expect(result.s).toBeCloseTo(ZOOM_OUT_FACTOR);
    });

    it("keeps the cursor point fixed in SVG space (origin cursor)", () => {
      const result = computeWheelZoom(baseTf, 0, 0, 1);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(0);
    });

    it("keeps the cursor point fixed in SVG space (non-origin cursor)", () => {
      const curr: Tf = { x: 50, y: 80, s: 3 };
      const mx = 300;
      const my = 240;
      const result = computeWheelZoom(curr, mx, my, 1);
      const svgX = (mx - curr.x) / curr.s;
      const svgY = (my - curr.y) / curr.s;
      expect(result.x).toBeCloseTo(mx - svgX * result.s);
      expect(result.y).toBeCloseTo(my - svgY * result.s);
    });

    it("produces the correct absolute transform values for known inputs", () => {
      const curr: Tf = { x: 0, y: 0, s: 1 };
      const result = computeWheelZoom(curr, 200, 150, 100);
      const expectedS = ZOOM_OUT_FACTOR;
      expect(result.s).toBeCloseTo(expectedS);
      expect(result.x).toBeCloseTo(200 - 200 * expectedS);
      expect(result.y).toBeCloseTo(150 - 150 * expectedS);
    });
  });

  describe("scale clamping", () => {
    it("does not exceed MAX_SCALE when already at the upper bound", () => {
      const tf: Tf = { x: 0, y: 0, s: MAX_SCALE };
      expect(computeWheelZoom(tf, 0, 0, -1).s).toBe(MAX_SCALE);
    });

    it("does not go below MIN_SCALE when already at the lower bound", () => {
      const tf: Tf = { x: 0, y: 0, s: MIN_SCALE };
      expect(computeWheelZoom(tf, 0, 0, 1).s).toBe(MIN_SCALE);
    });
  });
});

// ── ZoneEditor component integration tests ─────────────────────────────────────

describe("ZoneEditor — wheel-zoom integration", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Pre-populate the admin token so the component skips the login modal.
    // Without this, the password <input> remains focused and interactions that
    // check document.activeElement silently no-op before reaching the canvas.
    sessionStorage.setItem("zoneEditorAdminToken", "test-token");
    addEventListenerSpy = vi.spyOn(EventTarget.prototype, "addEventListener");
  });

  afterEach(() => {
    sessionStorage.removeItem("zoneEditorAdminToken");
    vi.restoreAllMocks();
  });

  it("registers the wheel listener on the SVG element with { passive: false }", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    const wheelCalls = addEventListenerSpy.mock.calls.filter(
      ([event]: [string, ...unknown[]]) => event === "wheel",
    );
    expect(wheelCalls.length).toBeGreaterThanOrEqual(1);

    const passiveFalseCalls = wheelCalls.filter(
      ([, , opts]: [string, unknown, unknown]) =>
        opts !== null &&
        typeof opts === "object" &&
        (opts as AddEventListenerOptions).passive === false,
    );
    expect(passiveFalseCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("calls preventDefault() on a zoom-in wheel event (deltaY < 0)", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    const svgEl = getSvgElement(container);
    const event = makeWheelEvent(-100);
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");

    await act(async () => {
      svgEl.dispatchEvent(event);
    });

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it("calls preventDefault() on a zoom-out wheel event (deltaY > 0)", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    const svgEl = getSvgElement(container);
    const event = makeWheelEvent(100);
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");

    await act(async () => {
      svgEl.dispatchEvent(event);
    });

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it("increases the canvas scale after a zoom-in wheel event (deltaY < 0)", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    const svgEl = getSvgElement(container);
    const g = getTransformGroup(container);
    const initialScale = parseScale(g.getAttribute("transform") ?? "");

    await act(async () => {
      svgEl.dispatchEvent(makeWheelEvent(-100));
    });

    const newScale = parseScale(g.getAttribute("transform") ?? "");
    expect(newScale).toBeGreaterThan(initialScale);
    expect(newScale).toBeCloseTo(initialScale * ZOOM_IN_FACTOR);
  });

  it("decreases the canvas scale after a zoom-out wheel event (deltaY > 0)", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    const svgEl = getSvgElement(container);
    const g = getTransformGroup(container);
    const initialScale = parseScale(g.getAttribute("transform") ?? "");

    await act(async () => {
      svgEl.dispatchEvent(makeWheelEvent(100));
    });

    const newScale = parseScale(g.getAttribute("transform") ?? "");
    expect(newScale).toBeLessThan(initialScale);
    expect(newScale).toBeCloseTo(initialScale * ZOOM_OUT_FACTOR);
  });

  it("accumulates scale changes across multiple wheel events", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    const svgEl = getSvgElement(container);
    const g = getTransformGroup(container);
    const initialScale = parseScale(g.getAttribute("transform") ?? "");

    await act(async () => {
      svgEl.dispatchEvent(makeWheelEvent(-100));
      svgEl.dispatchEvent(makeWheelEvent(-100));
    });

    const newScale = parseScale(g.getAttribute("transform") ?? "");
    expect(newScale).toBeCloseTo(initialScale * ZOOM_IN_FACTOR * ZOOM_IN_FACTOR);
  });

  it("adjusts pan position to keep the cursor fixed when zooming at a non-origin point", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    const svgEl = getSvgElement(container);
    vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
      left: 50, top: 30, right: 850, bottom: 630,
      width: 800, height: 600, x: 50, y: 30,
      toJSON: () => ({}),
    });

    const g = getTransformGroup(container);
    const initialTransform = g.getAttribute("transform") ?? "";
    const initialScale = parseScale(initialTransform);

    await act(async () => {
      svgEl.dispatchEvent(makeWheelEvent(-100, { clientX: 250, clientY: 180 }));
    });

    const newTransform = g.getAttribute("transform") ?? "";
    const newScale = parseScale(newTransform);

    expect(newScale).toBeCloseTo(initialScale * ZOOM_IN_FACTOR);

    const txMatch = newTransform.match(/translate\(([^,]+),([^)]+)\)/);
    expect(txMatch).not.toBeNull();
    const newX = parseFloat(txMatch![1]!);
    const newY = parseFloat(txMatch![2]!);

    const mx = 250 - 50;
    const my = 180 - 30;
    const expectedX = mx - (mx / initialScale) * newScale;
    const expectedY = my - (my / initialScale) * newScale;
    expect(newX).toBeCloseTo(expectedX);
    expect(newY).toBeCloseTo(expectedY);
  });

  it("removes the wheel listener when the component unmounts", async () => {
    const removeEventListenerSpy = vi.spyOn(EventTarget.prototype, "removeEventListener");

    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(<ZoneEditor />));
    });

    await act(async () => {
      unmount();
    });

    const wheelRemovals = removeEventListenerSpy.mock.calls.filter(
      ([event]) => event === "wheel",
    );
    expect(wheelRemovals.length).toBeGreaterThanOrEqual(1);
  });
});
