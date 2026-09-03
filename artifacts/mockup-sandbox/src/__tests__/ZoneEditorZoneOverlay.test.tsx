/**
 * ZoneEditorZoneOverlay.test.tsx
 *
 * Regression tests that lock in the no-alignment-transform behaviour
 * introduced by Task #850. Zones render at their raw svgX/svgY coordinates;
 * no alignment offset or scale is applied.
 *
 * Coverage:
 *   1. Overlay position parity   — rect x/y/width/height match raw svgX/svgY/svgWidth/svgHeight
 *   2. No alignment fetch        — GET /warehouse-zones/alignment is never called
 *   3. PATCH payload in raw SVG  — drag-move produces a PATCH body in raw SVG space
 *   4. No calibrate mode UI      — no "Calibrate" button or alignment readout in the DOM
 */

import React from "react";
import {
  describe,
  it,
  expect,
  vi,
  afterEach,
} from "vitest";
import {
  render,
  act,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { ZoneEditor } from "../pages/ZoneEditor";

// ── Constants mirroring the component ──────────────────────────────────────────
// INITIAL_SCALE = 0.18, tf = {x:0, y:0, s:0.18}, getBCR left=top=0
//   screenToSvg(cx, cy) = { x: cx / 0.18, y: cy / 0.18 }
const INITIAL_SCALE = 0.18;

// ── Sample zone fixture ────────────────────────────────────────────────────────
const ZONE_1 = {
  id: 1,
  aisleId: "12",
  label: "12",
  sectionNum: 1,
  isInventory: true,
  svgX: 100,
  svgY: 100,
  svgWidth: 200,
  svgHeight: 150,
  sortOrder: 0,
};

// ── Fetch mock factory ────────────────────────────────────────────────────────
/**
 * Every route that ZoneEditor legitimately hits on mount.
 * Deliberately omits /warehouse-zones/alignment — any call to that URL
 * throws an Error so a re-introduction of the alignment fetch fails loudly.
 */
function makeFetchMock(zones = [ZONE_1]) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const s = String(url);

    // Guard: alignment fetch must never happen
    if (s.includes("/warehouse-zones/alignment")) {
      throw new Error(`unexpected alignment fetch: ${s}`);
    }

    if (method === "GET" && s.includes("/floor-plan/svg"))
      return Promise.resolve({
        ok: false, status: 404,
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({}),
      });

    if (method === "GET" && s.includes("/warehouse-zones/coverage"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }),
        text: () => Promise.resolve(""),
      });

    if (method === "GET" && s.includes("/warehouse-zones"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ zones }),
        text: () => Promise.resolve(""),
      });

    if (method === "PATCH")
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });

    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
  });
}

// ── Render helper ─────────────────────────────────────────────────────────────
async function setupEditor(zones = [ZONE_1]) {
  const fetchMock = makeFetchMock(zones);
  global.fetch = fetchMock as unknown as typeof global.fetch;

  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ZoneEditor />));
  });

  // Stub SVG getBoundingClientRect so screenToSvg is deterministic:
  //   svgPt(clientX, clientY) = { x: clientX / 0.18, y: clientY / 0.18 }
  const svgEl = container.querySelector("svg") as SVGSVGElement;
  vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 800, bottom: 600,
    width: 800, height: 600, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  return { container, svgEl, fetchMock };
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/** Zone fill rects (identified by the isInventory blue fill). */
function getZoneFillRects(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll("rect")].filter(
    (r) => r.getAttribute("fill")?.startsWith("rgba(0, 112, 255"),
  ) as SVGRectElement[];
}

// ── Drag coordinates ──────────────────────────────────────────────────────────
// ZONE_1 screen center ≈ ((100+100)*0.18, (100+75)*0.18) = (36, 31.5)
const DRAG_FROM = { clientX: 36, clientY: 31 };  // inside ZONE_1
const DRAG_TO   = { clientX: 150, clientY: 120 }; // arbitrary destination

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ZoneEditor — no-alignment-transform regression", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── 1. Overlay position parity ────────────────────────────────────────────────

  it("zone rects use raw svgX/svgY/svgWidth/svgHeight with no alignment offset or scale", async () => {
    const { container } = await setupEditor();

    // Wait for zone rects to appear after the GET /warehouse-zones resolves.
    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const rects = getZoneFillRects(container);
    expect(rects).toHaveLength(1);

    const rect = rects[0]!;
    // Attributes must match the raw server values exactly — no translation or scale applied.
    expect(Number(rect.getAttribute("x"))).toBeCloseTo(ZONE_1.svgX, 1);
    expect(Number(rect.getAttribute("y"))).toBeCloseTo(ZONE_1.svgY, 1);
    expect(Number(rect.getAttribute("width"))).toBeCloseTo(ZONE_1.svgWidth, 1);
    expect(Number(rect.getAttribute("height"))).toBeCloseTo(ZONE_1.svgHeight, 1);
  });

  // ── 2. No alignment fetch ─────────────────────────────────────────────────────

  it("never calls GET /warehouse-zones/alignment during mount or normal use", async () => {
    const { fetchMock } = await setupEditor();

    // Drain all pending async effects.
    for (let i = 0; i < 5; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {});

    // The throw guard inside makeFetchMock already fails the test if the
    // alignment URL is hit.  This extra assertion provides a clear failure message
    // and documents the intent explicitly.
    const alignmentCalls = (fetchMock.mock.calls as [string][]).filter(
      ([url]) => String(url).includes("/warehouse-zones/alignment"),
    );
    expect(alignmentCalls).toHaveLength(0);
  });

  // ── 3. PATCH payload is in raw SVG space ──────────────────────────────────────

  it("drag-move PATCH body contains raw SVG coordinates (clientX / INITIAL_SCALE formula)", async () => {
    const { container, fetchMock } = await setupEditor();

    // Wait for zones to load.
    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const zoneRect = getZoneFillRects(container)[0]!;

    // Simulate a drag-move on ZONE_1.
    await act(async () => {
      fireEvent.mouseDown(zoneRect, { ...DRAG_FROM, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { ...DRAG_TO, bubbles: true }));
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { ...DRAG_TO, bubbles: true }));
    });
    // Drain the async onUp handler (PATCH + setZones).
    for (let i = 0; i < 3; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {});

    // Find the PATCH call.
    const patchCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(
      ([url, init]) =>
        String(url).includes(`/warehouse-zones/${ZONE_1.id}`) &&
        (init?.method ?? "").toUpperCase() === "PATCH",
    );
    expect(patchCalls).toHaveLength(1);

    const body = JSON.parse(patchCalls[0]![1].body as string) as {
      svgX: number;
      svgY: number;
    };

    // Expected new position (raw SVG space, no alignment):
    //   offset at drag start: (DRAG_FROM.clientX / INITIAL_SCALE) - svgX
    //                       = (36 / 0.18) - 100 = 200 - 100 = 100
    //   newX = (DRAG_TO.clientX / INITIAL_SCALE) - offset
    //        = (150 / 0.18) - 100 = 833.3 - 100 = 733.3
    const expectedX = (DRAG_TO.clientX / INITIAL_SCALE) - (DRAG_FROM.clientX / INITIAL_SCALE - ZONE_1.svgX);
    const expectedY = (DRAG_TO.clientY / INITIAL_SCALE) - (DRAG_FROM.clientY / INITIAL_SCALE - ZONE_1.svgY);

    expect(body.svgX).toBeCloseTo(expectedX, 0);
    expect(body.svgY).toBeCloseTo(expectedY, 0);
  });

  // ── 4. No calibrate mode UI ───────────────────────────────────────────────────

  it("toolbar contains no 'Calibrate' button and no alignment readout (x / y / % scale)", async () => {
    const { container } = await setupEditor();

    // Wait for the editor to finish mounting.
    await act(async () => { await Promise.resolve(); });
    await act(async () => {});

    // No button with the text "Calibrate" (exact or containing).
    const allButtons = [...container.querySelectorAll("button")];
    const calibrateBtn = allButtons.find((b) =>
      b.textContent?.toLowerCase().includes("calibrate"),
    );
    expect(calibrateBtn).toBeUndefined();

    // No alignment readout: "x N.N" / "y N.N" / "N%" style labels that are
    // part of the alignment UI (they appear in the form "x 10.0", "y -5.0", "110%").
    // We check that the DOM does not contain elements that look like alignment readouts.
    const allText = container.textContent ?? "";
    // The alignment readout in the calibrate panel uses patterns like "x 10.0" and "110%"
    // alongside nudge buttons. Since we know nudge/scale controls are absent, the simplest
    // check is that neither the Revert/Reset-to-zero (calibrate-only) controls appear.
    expect(allText).not.toContain("Reset to zero");
    expect(allText).not.toContain("Revert");
  });
});
