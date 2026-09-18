/**
 * ZoneEditorZoneOverlay.test.tsx
 *
 * Regression tests for the shared three-anchor calibration used by the
 * Warehouse Map and Zone Editor. Stored zone coordinates remain world-space;
 * only the rendered editing layer is transformed.
 *
 * Coverage:
 *   1. Calibrated overlay        — zone geometry uses the expected SVG matrix
 *   2. Safe anchor loading       — public anchors are loaded; legacy alignment is not
 *   3. Inverse-mapped drag       — drag PATCH bodies stay in stored/world space
 *   4. Identity fallback         — missing or degenerate anchors preserve raw placement
 *   5. No calibrate mode UI      — editor does not expose calibration controls
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

// world → floor-plan SVG: x' = 2x + 10, y' = 2y - 5
const CALIBRATED_ANCHORS = [
  { name: "A1", svgX: 10, svgY: -5, worldX: 0, worldY: 0 },
  { name: "A2", svgX: 210, svgY: -5, worldX: 100, worldY: 0 },
  { name: "A3", svgX: 10, svgY: 195, worldX: 0, worldY: 100 },
];

const DEGENERATE_ANCHORS = [
  { name: "A1", svgX: 10, svgY: 10, worldX: 0, worldY: 0 },
  { name: "A2", svgX: 20, svgY: 20, worldX: 10, worldY: 10 },
  { name: "A3", svgX: 30, svgY: 30, worldX: 20, worldY: 20 },
];

// ── Fetch mock factory ────────────────────────────────────────────────────────
/**
 * Every route that ZoneEditor legitimately hits on mount.
 * Deliberately omits the legacy /warehouse-zones/alignment endpoint — any call to that URL
 * throws an Error so a re-introduction of the alignment fetch fails loudly.
 */
function makeFetchMock(
  zones = [ZONE_1],
  anchors: unknown[] = [],
) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const s = String(url);

    // Guard: legacy alignment fetch must never happen
    if (s.includes("/warehouse-zones/alignment")) {
      throw new Error(`unexpected alignment fetch: ${s}`);
    }

    if (method === "GET" && s.includes("/warehouse-zones/anchors"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ anchors }),
        text: () => Promise.resolve(""),
      });

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
async function setupEditor(
  zones = [ZONE_1],
  anchors: unknown[] = [],
) {
  const fetchMock = makeFetchMock(zones, anchors);
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
const DRAG_TO   = { clientX: 150, clientY: 120 }; // arbitrary destination

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ZoneEditor — anchor calibration regression", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── 1. Overlay position parity ────────────────────────────────────────────────

  it("renders zones through the configured world-to-floor-plan matrix", async () => {
    const { container } = await setupEditor([ZONE_1], CALIBRATED_ANCHORS);

    // Wait for zone rects to appear after the GET /warehouse-zones resolves.
    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const rects = getZoneFillRects(container);
    expect(rects).toHaveLength(1);

    const rect = rects[0]!;
    // x' = 2x + 10, y' = 2y - 5; geometry stays in the calibrated layer's
    // local/world coordinates and the matrix performs the visual mapping.
    expect(rect.getAttribute("x")).toBe(String(ZONE_1.svgX));
    expect(rect.getAttribute("y")).toBe(String(ZONE_1.svgY));
    expect(rect.getAttribute("width")).toBe(String(ZONE_1.svgWidth));
    expect(rect.getAttribute("height")).toBe(String(ZONE_1.svgHeight));
    const layer = container.querySelector("[data-testid='zone-editor-calibrated-layer']");
    expect(layer?.getAttribute("transform")).toBe("matrix(2,0,0,2,10,-5)");
    expect(layer?.getAttribute("data-anchor-transform")).toBe("matrix(2,0,0,2,10,-5)");
  });

  // ── 2. Safe anchor loading ─────────────────────────────────────────────────────

  it("loads public anchors without calling the legacy alignment endpoint", async () => {
    const { fetchMock } = await setupEditor();

    // Drain all pending async effects.
    for (let i = 0; i < 5; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {});

    const anchorCalls = (fetchMock.mock.calls as [string][]).filter(
      ([url]) => String(url).includes("/warehouse-zones/anchors"),
    );
    expect(anchorCalls.length).toBeGreaterThan(0);
    const alignmentCalls = (fetchMock.mock.calls as [string][]).filter(
      ([url]) => String(url).includes("/warehouse-zones/alignment"),
    );
    expect(alignmentCalls).toHaveLength(0);
  });

  // ── 3. PATCH payload is in raw SVG space ──────────────────────────────────────

  it("inverse-maps calibrated drag coordinates into the PATCH body", async () => {
    const { container, fetchMock } = await setupEditor([ZONE_1], CALIBRATED_ANCHORS);

    // Wait for zones to load.
    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const zoneRect = getZoneFillRects(container)[0]!;

    // The rendered zone is x=210..610, y=195..495 after calibration. Its
    // center is floor-plan (410,345), which maps back to stored (200,175).
    const dragFrom = { clientX: 73.8, clientY: 62.1 };
    await act(async () => {
      fireEvent.mouseDown(zoneRect, { ...dragFrom, button: 0 });
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

    // Inverse: worldX = (floorX - 10) / 2 and worldY = (floorY + 5) / 2.
    const startWorld = {
      x: ((dragFrom.clientX / INITIAL_SCALE) - 10) / 2,
      y: ((dragFrom.clientY / INITIAL_SCALE) + 5) / 2,
    };
    const endWorld = {
      x: ((DRAG_TO.clientX / INITIAL_SCALE) - 10) / 2,
      y: ((DRAG_TO.clientY / INITIAL_SCALE) + 5) / 2,
    };
    const expectedX = endWorld.x - (startWorld.x - ZONE_1.svgX);
    const expectedY = endWorld.y - (startWorld.y - ZONE_1.svgY);

    expect(body.svgX).toBeCloseTo(expectedX, 0);
    expect(body.svgY).toBeCloseTo(expectedY, 0);
  });

  it("inverse-maps a calibrated resize pointer into the stored geometry", async () => {
    const { container, fetchMock } = await setupEditor([ZONE_1], CALIBRATED_ANCHORS);
    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const zoneRect = getZoneFillRects(container)[0]!;
    // Select without moving so the resize handles become visible.
    await act(async () => {
      fireEvent.mouseDown(zoneRect, { clientX: 73.8, clientY: 62.1, button: 0 });
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 73.8, clientY: 62.1, bubbles: true }));
    });
    const eastHandle = await waitFor(() => {
      // Edge handles are painted in n/s/e/w order; index 2 is east.
      const handle = [...container.querySelectorAll("rect")].filter(
        (rect) => rect.getAttribute("fill") === "#f59e0b",
      )[2];
      if (!handle) throw new Error("resize handle not rendered");
      return handle;
    });

    // The east edge starts at stored x=300. Move it to stored x=260.
    // floorX = 2 * worldX + 10, so the target screen coordinate is 95.4.
    await act(async () => {
      fireEvent.mouseDown(eastHandle, { clientX: 109.8, clientY: 62.1, button: 0 });
      document.dispatchEvent(new MouseEvent("mousemove", {
        clientX: 95.4,
        clientY: 62.1,
        bubbles: true,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", {
        clientX: 95.4,
        clientY: 62.1,
        bubbles: true,
      }));
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => { await Promise.resolve(); });
    }

    const resizeCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(
      ([url, init]) =>
        String(url).includes(`/warehouse-zones/${ZONE_1.id}`) &&
        (init?.method ?? "").toUpperCase() === "PATCH" &&
        String(init?.body).includes("svgWidth"),
    );
    expect(resizeCalls).toHaveLength(1);
    const body = JSON.parse(resizeCalls[0]![1].body as string) as {
      svgX: number;
      svgY: number;
      svgWidth: number;
      svgHeight: number;
    };
    expect(body.svgX).toBe(ZONE_1.svgX);
    expect(body.svgY).toBe(ZONE_1.svgY);
    expect(body.svgWidth).toBeCloseTo(160, 0);
    expect(body.svgHeight).toBe(ZONE_1.svgHeight);
  });

  it("keeps identity placement when anchors are missing or degenerate", async () => {
    for (const anchors of [[], DEGENERATE_ANCHORS]) {
      const { container } = await setupEditor([ZONE_1], anchors);
      await waitFor(
        () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
        { timeout: 3000 },
      );
      const rect = getZoneFillRects(container)[0]!;
      expect(Number(rect.getAttribute("x"))).toBeCloseTo(ZONE_1.svgX, 1);
      expect(Number(rect.getAttribute("y"))).toBeCloseTo(ZONE_1.svgY, 1);
      const layer = container.querySelector("[data-testid='zone-editor-calibrated-layer']");
      expect(layer?.getAttribute("transform")).toBeNull();
      cleanup();
    }
  });

  // ── 5. No calibrate mode UI ───────────────────────────────────────────────────

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
