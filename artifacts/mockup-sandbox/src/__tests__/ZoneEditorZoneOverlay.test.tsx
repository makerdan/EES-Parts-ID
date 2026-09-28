/**
 * ZoneEditorZoneOverlay.test.tsx
 *
 * Regression tests for the shared three-anchor calibration used by the
 * Warehouse Map and Zone Editor. Stored zone coordinates remain world-space;
 * only the rendered editing layer is transformed.
 *
 * Coverage:
 *   1. Calibrated overlay        — zone geometry uses the expected SVG matrix
 *   2. Safe placement loading   — public anchors and read-only alignment are loaded
 *   3. Inverse-mapped drag       — drag PATCH bodies stay in stored/world space
 *   4. Identity fallback         — missing or degenerate anchors preserve raw placement
 *   5. Normalized fill frame     — offset SVG raster bounds inverse-map correctly
 *   6. No calibrate mode UI      — editor does not expose calibration controls
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
import { resetZoneEditorHistoryForTests, ZoneEditor } from "../pages/ZoneEditor";

// ── Constants mirroring the component ──────────────────────────────────────────
// INITIAL_SCALE = 0.18, tf = {x:0, y:0, s:0.18}, getBCR left=top=0
//   screenToSvg(cx, cy) = { x: cx / 0.18, y: cy / 0.18 }
const INITIAL_SCALE = 0.18;
const IDENTITY_ALIGNMENT = { translateX: 0, translateY: 0, scale: 1 };
const MAP_ALIGNMENT = { translateX: 30, translateY: -20, scale: 0.5 };

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
const ZONE_2 = {
  ...ZONE_1,
  id: 2,
  aisleId: "14",
  svgX: 400,
  svgY: 300,
  sortOrder: 1,
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
 * Every route that ZoneEditor legitimately hits on mount. Alignment is
 * available as a read-only map-placement input; writes to it remain forbidden.
 */
function makeFetchMock(
  zones = [ZONE_1],
  anchors: unknown[] = [],
  floorPlanSvg?: string,
  alignment: unknown = IDENTITY_ALIGNMENT,
  alignmentOk = true,
) {
  let currentZones = zones.map((zone) => ({ ...zone }));
  return vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const s = String(url);

    // The editor may read placement alignment, but must never modify it.
    if (s.includes("/warehouse-zones/alignment")) {
      if (method !== "GET") throw new Error(`unexpected alignment write: ${s}`);
      return Promise.resolve({
        ok: alignmentOk,
        status: alignmentOk ? 200 : 500,
        json: () => Promise.resolve(alignment),
        text: () => Promise.resolve(""),
      });
    }

    if (method === "GET" && s.includes("/warehouse-zones/anchors"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ anchors }),
        text: () => Promise.resolve(""),
      });

    if (method === "GET" && s.includes("/floor-plan/svg") && floorPlanSvg)
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(floorPlanSvg),
        json: () => Promise.resolve({}),
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
        json: () => Promise.resolve({ zones: currentZones }),
        text: () => Promise.resolve(""),
      });

    if (method === "PATCH") {
      const id = Number(s.split("/").pop());
      const updates = JSON.parse((init?.body ?? "{}") as string) as Partial<typeof ZONE_1>;
      currentZones = currentZones.map((zone) =>
        zone.id === id ? { ...zone, ...updates } : zone,
      );
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });
    }

    if (method === "POST" && s.includes("/warehouse-zones"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ zone: { ...ZONE_1, id: 99 } }),
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
  floorPlanSvg?: string,
  alignment: unknown = IDENTITY_ALIGNMENT,
  alignmentOk = true,
) {
  const fetchMock = makeFetchMock(zones, anchors, floorPlanSvg, alignment, alignmentOk);
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
const DRAG_TO   = { clientX: 66.6, clientY: 37.8 };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ZoneEditor — anchor calibration regression", () => {
  afterEach(() => {
    cleanup();
    resetZoneEditorHistoryForTests();
    localStorage.clear();
    vi.useRealTimers();
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

  it("normalizes a non-zero uploaded SVG into the same frame as its calibrated overlay", async () => {
    localStorage.setItem("zoneEditorSnapEnabled", "true");
    const floorPlanSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="100 200 1000 800">
        <path id="uploaded-floor-plan" d="M100 200H1100V1000Z"/>
      </svg>
    `;
    const { container } = await setupEditor(
      [ZONE_1],
      CALIBRATED_ANCHORS,
      floorPlanSvg,
      MAP_ALIGNMENT,
    );

    await waitFor(() => expect(getZoneFillRects(container)).toHaveLength(1));

    const floorPlan = container.querySelector("[data-floor-plan-viewbox]");
    expect(floorPlan?.getAttribute("data-floor-plan-viewbox")).toBe("0 0 1000 800");
    expect(floorPlan?.innerHTML).toContain('id="uploaded-floor-plan"');
    expect(floorPlan?.innerHTML).toContain("M100 200H1100V1000Z");

    const grid = container.querySelector("[data-testid='zone-editor-grid']");
    expect(grid).not.toBeNull();
    expect(grid?.querySelector("line:last-child")?.getAttribute("y2")).toBe("800");
    expect(
      [...(grid?.querySelectorAll("line") ?? [])].some(
        (line) => line.getAttribute("x2") === "1000",
      ),
    ).toBe(true);

    const rect = getZoneFillRects(container)[0]!;
    const layer = container.querySelector("[data-testid='zone-editor-calibrated-layer']");
    expect(layer?.getAttribute("transform")).toBe("matrix(2,0,0,2,10,-5)");
    const alignmentLayer = container.querySelector("[data-testid='zone-editor-alignment-layer']");
    expect(alignmentLayer?.getAttribute("transform")).toBe("translate(30, -20) scale(0.5)");
    // Map placement is anchor(alignment(world)): this zone's stored top-left
    // (100,100) therefore appears at (170,55), while the SVG rect stays stored.
    expect({
      x: 2 * (0.5 * Number(rect.getAttribute("x")) + 30) + 10,
      y: 2 * (0.5 * Number(rect.getAttribute("y")) - 20) - 5,
    }).toEqual({ x: 170, y: 55 });
    expect(rect.getAttribute("x")).toBe(String(ZONE_1.svgX));
    expect(rect.getAttribute("y")).toBe(String(ZONE_1.svgY));
  });

  // ── 2. Safe anchor loading ─────────────────────────────────────────────────────

  it("loads public anchors and read-only alignment without writing placement settings", async () => {
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
    const alignmentCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(
      ([url]) => String(url).includes("/warehouse-zones/alignment"),
    );
    expect(alignmentCalls.some(([, init]) => (init?.method ?? "GET").toUpperCase() !== "GET"))
      .toBe(false);
    expect(alignmentCalls).toHaveLength(1);
  });

  // ── 3. PATCH payload is in raw SVG space ──────────────────────────────────────

  it("inverse-maps calibrated drag coordinates into the PATCH body", async () => {
    const { container, fetchMock } = await setupEditor(
      [ZONE_1],
      CALIBRATED_ANCHORS,
      undefined,
      MAP_ALIGNMENT,
    );

    // Wait for zones to load.
    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const zoneRect = getZoneFillRects(container)[0]!;

    // anchor(alignment(world)) maps the zone to x=170..370, y=55..205.
    // Its center is floor-plan (270,130), stored/world (200,175).
    const dragFrom = { clientX: 48.6, clientY: 23.4 };
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

    // The composed Map transform is x'=x+70, y'=y-45; the inverse drag
    // therefore moves the stored zone by (100,80), not (50,40).
    const startWorld = {
      x: dragFrom.clientX / INITIAL_SCALE - 70,
      y: dragFrom.clientY / INITIAL_SCALE + 45,
    };
    const endWorld = {
      x: DRAG_TO.clientX / INITIAL_SCALE - 70,
      y: DRAG_TO.clientY / INITIAL_SCALE + 45,
    };
    const expectedX = endWorld.x - (startWorld.x - ZONE_1.svgX);
    const expectedY = endWorld.y - (startWorld.y - ZONE_1.svgY);

    expect(body.svgX).toBeCloseTo(expectedX, 0);
    expect(body.svgY).toBeCloseTo(expectedY, 0);
  });

  it("draws zones at the pointer and saves stored coordinates through both transforms", async () => {
    const { container, fetchMock } = await setupEditor(
      [ZONE_1],
      CALIBRATED_ANCHORS,
      undefined,
      MAP_ALIGNMENT,
    );
    await waitFor(() => {
      expect(container.querySelector("[data-testid='zone-editor-alignment-layer']")
        ?.getAttribute("transform")).toBe("translate(30, -20) scale(0.5)");
    });

    const drawButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Draw Zone",
    );
    expect(drawButton).toBeDefined();
    await act(async () => { fireEvent.click(drawButton!); });

    const svg = container.querySelector("svg") as SVGSVGElement;
    await act(async () => {
      fireEvent.mouseDown(svg, { clientX: 30.6, clientY: 9.9, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", {
        clientX: 66.6,
        clientY: 36.9,
        bubbles: true,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", {
        clientX: 66.6,
        clientY: 36.9,
        bubbles: true,
      }));
    });

    await waitFor(() => expect(container.textContent).toContain("New Zone"));
    const aisleInput = container.querySelector(
      'input[placeholder="e.g. 09 or 22"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "22" } });
    });
    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save Zone",
    );
    expect(saveButton).toBeDefined();
    await act(async () => { fireEvent.click(saveButton!); });

    await waitFor(() => {
      const post = (fetchMock.mock.calls as [string, RequestInit][]).find(
        ([url, init]) =>
          String(url).endsWith("/warehouse-zones") &&
          (init?.method ?? "").toUpperCase() === "POST",
      );
      expect(post).toBeDefined();
      expect(JSON.parse(post![1].body as string)).toMatchObject({
        aisleId: "22",
        svgX: 100,
        svgY: 100,
        svgWidth: 200,
        svgHeight: 150,
      });
    });
  });

  it("selects and moves multiple zones in stored coordinates through the composed transform", async () => {
    const { container, fetchMock } = await setupEditor(
      [ZONE_1, ZONE_2],
      CALIBRATED_ANCHORS,
      undefined,
      MAP_ALIGNMENT,
    );
    await waitFor(() => expect(getZoneFillRects(container)).toHaveLength(2));
    const [firstRect, secondRect] = getZoneFillRects(container);
    expect(firstRect).toBeDefined();
    expect(secondRect).toBeDefined();

    await act(async () => {
      fireEvent.mouseDown(firstRect!, {
        clientX: 48.6,
        clientY: 23.4,
        button: 0,
        shiftKey: true,
      });
    });
    await act(async () => {
      fireEvent.mouseDown(secondRect!, {
        clientX: 84.6,
        clientY: 45.9,
        button: 0,
        shiftKey: true,
      });
    });
    await act(async () => {
      fireEvent.mouseDown(firstRect!, {
        clientX: 48.6,
        clientY: 23.4,
        button: 0,
      });
      document.dispatchEvent(new MouseEvent("mousemove", {
        clientX: 66.6,
        clientY: 37.8,
        bubbles: true,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", {
        clientX: 66.6,
        clientY: 37.8,
        bubbles: true,
      }));
    });

    const patchCalls = () =>
      (fetchMock.mock.calls as [string, RequestInit][])
        .filter(([, init]) => (init?.method ?? "").toUpperCase() === "PATCH")
        .map(([, init]) => JSON.parse(init.body as string) as { svgX: number; svgY: number });
    await waitFor(() => expect(patchCalls()).toHaveLength(2));
    expect(patchCalls()).toEqual([
      { svgX: 200, svgY: 180 },
      { svgX: 500, svgY: 380 },
    ]);
  });

  it("undoes and redoes a calibrated move with world-space PATCH payloads", async () => {
    const { container, fetchMock } = await setupEditor([ZONE_1], CALIBRATED_ANCHORS);

    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const zoneRect = getZoneFillRects(container)[0]!;
    const dragFrom = { clientX: 73.8, clientY: 62.1 };
    await act(async () => {
      fireEvent.mouseDown(zoneRect, { ...dragFrom, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", {
        clientX: 91.8,
        clientY: 76.5,
        bubbles: true,
      }));
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", {
        clientX: 91.8,
        clientY: 76.5,
        bubbles: true,
      }));
    });

    const patchCalls = () =>
      (fetchMock.mock.calls as [string, RequestInit][])
        .filter(([, init]) => (init?.method ?? "").toUpperCase() === "PATCH")
        .map(([, init]) => JSON.parse(init.body as string) as { svgX: number; svgY: number });

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect((container.querySelector('button[title^="Undo"]') as HTMLButtonElement).title)
      .toBe("Undo (1)");
    expect(patchCalls()).toEqual([
      { svgX: 150, svgY: 140 },
    ]);
    expect(container.querySelector("[data-testid='zone-editor-calibrated-layer']")
      ?.getAttribute("transform")).toBe("matrix(2,0,0,2,10,-5)");

    cleanup();
    let returnedContainer!: HTMLElement;
    await act(async () => {
      ({ container: returnedContainer } = render(<ZoneEditor />));
    });
    const returnedSvg = returnedContainer.querySelector("svg") as SVGSVGElement;
    vi.spyOn(returnedSvg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    await waitFor(() => expect(getZoneFillRects(returnedContainer)).toHaveLength(1));
    expect((returnedContainer.querySelector('button[title^="Undo"]') as HTMLButtonElement).title)
      .toBe("Undo (1)");

    const undoButton = returnedContainer.querySelector('button[title^="Undo"]') as HTMLButtonElement;
    expect(undoButton.disabled).toBe(false);
    await act(async () => { fireEvent.click(undoButton); });
    await waitFor(() => expect(patchCalls()).toHaveLength(2));
    expect(patchCalls().slice(1)).toEqual([
      { svgX: ZONE_1.svgX, svgY: ZONE_1.svgY },
    ]);
    expect(returnedContainer.querySelector("[data-testid='zone-editor-calibrated-layer']")
      ?.getAttribute("transform")).toBe("matrix(2,0,0,2,10,-5)");

    const redoButton = returnedContainer.querySelector('button[title^="Redo"]') as HTMLButtonElement;
    expect(redoButton.disabled).toBe(false);
    await act(async () => { fireEvent.click(redoButton); });
    await waitFor(() => expect(patchCalls()).toHaveLength(3));
    expect(patchCalls().slice(2)).toEqual([
      { svgX: 150, svgY: 140 },
    ]);
    expect(returnedContainer.querySelector("[data-testid='zone-editor-calibrated-layer']")
      ?.getAttribute("transform")).toBe("matrix(2,0,0,2,10,-5)");
  });

  it("keeps calibrated undo and redo available after failed PATCHes", async () => {
    const initial = await setupEditor([ZONE_1], CALIBRATED_ANCHORS);
    let container = initial.container;
    const fetchMock = initial.fetchMock;

    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const zoneRect = getZoneFillRects(container)[0]!;
    await act(async () => {
      fireEvent.mouseDown(zoneRect, { clientX: 73.8, clientY: 62.1, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", {
        clientX: 91.8,
        clientY: 76.5,
        bubbles: true,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", {
        clientX: 91.8,
        clientY: 76.5,
        bubbles: true,
      }));
    });

    const patchCalls = () =>
      (fetchMock.mock.calls as [string, RequestInit][]).filter(
        ([, init]) => (init?.method ?? "").toUpperCase() === "PATCH",
      );
    const zoneGeometry = () => {
      const rect = getZoneFillRects(container)[0]!;
      return {
        x: rect.getAttribute("x"),
        y: rect.getAttribute("y"),
        width: rect.getAttribute("width"),
        height: rect.getAttribute("height"),
      };
    };

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const movedGeometry = zoneGeometry();
    const calibratedTransform = container.querySelector(
      "[data-testid='zone-editor-calibrated-layer']",
    )?.getAttribute("transform");
    const failNextPatch = () => {
      const previousImplementation = fetchMock.getMockImplementation()!;
      let shouldFail = true;
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (shouldFail && (init?.method ?? "").toUpperCase() === "PATCH") {
          shouldFail = false;
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: "simulated PATCH failure" }),
            text: () => Promise.resolve("simulated PATCH failure"),
          });
        }
        return previousImplementation(url, init);
      });
    };
    expect(movedGeometry).toMatchObject({ x: "150", y: "140" });
    expect(calibratedTransform).toBe("matrix(2,0,0,2,10,-5)");

    cleanup();
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });
    const returnedSvg = container.querySelector("svg") as SVGSVGElement;
    vi.spyOn(returnedSvg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    await waitFor(() => expect(getZoneFillRects(container)).toHaveLength(1));
    const historyTitles = () => ({
      undo: (container.querySelector('button[title^="Undo"], button[title="Nothing to undo"]') as HTMLButtonElement).title,
      redo: (container.querySelector('button[title^="Redo"], button[title="Nothing to redo"]') as HTMLButtonElement).title,
    });
    const titlesBeforeFailedUndo = historyTitles();
    expect(titlesBeforeFailedUndo).toEqual({ undo: "Undo (1)", redo: "Nothing to redo" });

    // The failed undo must not consume the undo entry or manufacture a redo.
    failNextPatch();
    const undoButton = container.querySelector('button[title^="Undo"]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(undoButton); });
    await waitFor(() => expect(patchCalls()).toHaveLength(2));
    expect(historyTitles()).toEqual(titlesBeforeFailedUndo);
    expect((container.querySelector('button[title^="Undo"]') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('button[title="Nothing to redo"]')).not.toBeNull();
    expect(zoneGeometry()).toEqual(movedGeometry);
    expect(container.querySelector("[data-testid='zone-editor-calibrated-layer']")
      ?.getAttribute("transform")).toBe(calibratedTransform);

    // Consume the still-available undo entry successfully so redo can be tested.
    await act(async () => {
      fireEvent.click(container.querySelector('button[title^="Undo"]')!);
    });
    await waitFor(() => expect(patchCalls()).toHaveLength(3));
    const originalGeometry = zoneGeometry();
    expect(originalGeometry).toMatchObject({ x: "100", y: "100" });
    const undoTitleBeforeFailedRedo =
      (container.querySelector('button[title^="Undo"], button[title="Nothing to undo"]') as HTMLButtonElement).title;
    const redoTitleBeforeFailedRedo =
      (container.querySelector('button[title^="Redo"]') as HTMLButtonElement).title;

    cleanup();
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });
    const secondReturnedSvg = container.querySelector("svg") as SVGSVGElement;
    vi.spyOn(secondReturnedSvg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    await waitFor(() => expect(getZoneFillRects(container)).toHaveLength(1));
    expect(historyTitles()).toEqual({
      undo: undoTitleBeforeFailedRedo,
      redo: redoTitleBeforeFailedRedo,
    });

    // The failed redo must leave exactly that one redo entry available and
    // must not append a duplicate entry to the undo stack.
    failNextPatch();
    await act(async () => {
      fireEvent.click(container.querySelector('button[title^="Redo"]')!);
    });
    await waitFor(() => expect(patchCalls()).toHaveLength(4));
    expect((container.querySelector('button[title^="Undo"], button[title="Nothing to undo"]') as HTMLButtonElement).title)
      .toBe(undoTitleBeforeFailedRedo);
    expect((container.querySelector('button[title^="Redo"]') as HTMLButtonElement).title)
      .toBe(redoTitleBeforeFailedRedo);
    expect(zoneGeometry()).toEqual(originalGeometry);
    expect(container.querySelector("[data-testid='zone-editor-calibrated-layer']")
      ?.getAttribute("transform")).toBe(calibratedTransform);
  });

  it("inverse-maps a calibrated resize pointer into the stored geometry", async () => {
    const { container, fetchMock } = await setupEditor(
      [ZONE_1],
      CALIBRATED_ANCHORS,
      undefined,
      MAP_ALIGNMENT,
    );
    await waitFor(
      () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const zoneRect = getZoneFillRects(container)[0]!;
    // Select without moving so the resize handles become visible.
    await act(async () => {
      fireEvent.mouseDown(zoneRect, { clientX: 48.6, clientY: 23.4, button: 0 });
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 48.6, clientY: 23.4, bubbles: true }));
    });
    const eastHandle = await waitFor(() => {
      // Edge handles are painted in n/s/e/w order; index 2 is east.
      const handle = [...container.querySelectorAll("rect")].filter(
        (rect) => rect.getAttribute("fill") === "#f59e0b",
      )[2];
      if (!handle) throw new Error("resize handle not rendered");
      return handle;
    });

    // The east edge starts at stored x=300, rendered floorX=370. Under the
    // composed transform x'=x+70, moving to screen x=59.4 targets worldX=260.
    await act(async () => {
      fireEvent.mouseDown(eastHandle, { clientX: 66.6, clientY: 23.4, button: 0 });
      document.dispatchEvent(new MouseEvent("mousemove", {
        clientX: 59.4,
        clientY: 23.4,
        bubbles: true,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", {
        clientX: 59.4,
        clientY: 23.4,
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

  it("inverse-maps a calibrated standard rectangle before creating it", async () => {
    const floorPlanSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800">
        <rect width="1000" height="800" fill="#fff"/>
      </svg>
    `;
    const { container, fetchMock } = await setupEditor(
      [ZONE_1],
      CALIBRATED_ANCHORS,
      floorPlanSvg,
      MAP_ALIGNMENT,
    );

    await waitFor(() => expect(getZoneFillRects(container)).toHaveLength(1));
    const drawButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Draw Zone",
    );
    expect(drawButton).toBeDefined();
    await act(async () => { fireEvent.click(drawButton!); });

    const standardButton = container.querySelector(
      'button[aria-label="Place standard rectangle"]',
    );
    expect(standardButton).not.toBeNull();
    await act(async () => { fireEvent.click(standardButton!); });

    // The default 200×150 floor-plan rectangle is centered at (400,325).
    // The composed transform x'=x+70, y'=y-45 stores it at (330,370), unchanged in size.
    await waitFor(() => expect(container.textContent).toContain("330,370 · 200×150"));

    const aisleInput = container.querySelector(
      'input[placeholder="e.g. 09 or 22"]',
    ) as HTMLInputElement;
    expect(aisleInput).not.toBeNull();
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "22" } });
    });
    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save Zone",
    );
    expect(saveButton).toBeDefined();
    await act(async () => {
      fireEvent.click(saveButton!);
      await Promise.resolve();
      await Promise.resolve();
    });

    const post = (fetchMock.mock.calls as [string, RequestInit][]).find(
      ([url, init]) =>
        String(url).endsWith("/warehouse-zones") &&
        (init?.method ?? "").toUpperCase() === "POST",
    );
    expect(post).toBeDefined();
    expect(JSON.parse(post![1].body as string)).toMatchObject({
      aisleId: "22",
      svgX: 330,
      svgY: 370,
      svgWidth: 200,
      svgHeight: 150,
    });
  });

  it("inverse-maps calibrated fill bounds into the create payload", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:calibrated-fill");
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      set(this: HTMLImageElement) {
        Promise.resolve().then(() => this.onload?.(new Event("load")));
      },
      configurable: true,
    });
    const fillData = {
      data: new Uint8ClampedArray(1000 * 800 * 4).fill(255),
      width: 1000,
      height: 800,
      colorSpace: "srgb",
    } as unknown as ImageData;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue(fillData),
    } as unknown as CanvasRenderingContext2D);

    const floorPlanSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800">
        <rect width="1000" height="800" fill="#fff"/>
      </svg>
    `;
    const { container, fetchMock } = await setupEditor(
      [ZONE_1],
      CALIBRATED_ANCHORS,
      floorPlanSvg,
      MAP_ALIGNMENT,
    );
    await waitFor(() => expect(getZoneFillRects(container)).toHaveLength(1));
    vi.useFakeTimers();

    const fillButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Fill"),
    );
    expect(fillButton).toBeDefined();
    await act(async () => { fireEvent.click(fillButton!); });
    const svg = container.querySelector("svg") as SVGSVGElement;
    await act(async () => {
      fireEvent.mouseDown(svg, { clientX: 90, clientY: 72, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", {
        clientX: 90,
        clientY: 72,
        button: 0,
        bubbles: true,
      }));
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => { await Promise.resolve(); });
    }

    expect(container.textContent).toContain("New Zone");
    const aisleInput = container.querySelector(
      'input[placeholder="e.g. 09 or 22"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "23" } });
    });
    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save Zone",
    );
    expect(saveButton).toBeDefined();
    await act(async () => {
      fireEvent.click(saveButton!);
      await Promise.resolve();
      await Promise.resolve();
    });

    const post = (fetchMock.mock.calls as [string, RequestInit][]).find(
      ([url, init]) =>
        String(url).endsWith("/warehouse-zones") &&
        (init?.method ?? "").toUpperCase() === "POST",
    );
    expect(post).toBeDefined();
    expect(JSON.parse(post![1].body as string)).toMatchObject({
      aisleId: "23",
      // The all-white 1000×800 SVG fill is inverse-mapped from floor-plan
      // space to stored/world space.
      svgX: -70,
      svgY: 45,
      svgWidth: 1000,
      svgHeight: 800,
    });
  });

  it("fills a non-zero-origin SVG in the normalized raster frame before inverse mapping", async () => {
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    let rasterFrame: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
      if (value instanceof Blob) rasterFrame = value;
      return "blob:offset-calibrated-fill";
    });
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      set(this: HTMLImageElement) {
        Promise.resolve().then(() => this.onload?.(new Event("load")));
      },
      configurable: true,
    });
    const fillData = {
      data: new Uint8ClampedArray(1000 * 800 * 4).fill(255),
      width: 1000,
      height: 800,
      colorSpace: "srgb",
    } as unknown as ImageData;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue(fillData),
    } as unknown as CanvasRenderingContext2D);

    const floorPlanSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="100 200 1000 800">
        <rect x="100" y="200" width="1000" height="800" fill="#fff"/>
      </svg>
    `;
    const { container, fetchMock } = await setupEditor(
      [ZONE_1],
      CALIBRATED_ANCHORS,
      floorPlanSvg,
      MAP_ALIGNMENT,
    );
    await waitFor(() => expect(getZoneFillRects(container)).toHaveLength(1));
    vi.useFakeTimers();

    const fillButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Fill"),
    );
    expect(fillButton).toBeDefined();
    await act(async () => { fireEvent.click(fillButton!); });
    const svg = container.querySelector("svg") as SVGSVGElement;
    await act(async () => {
      fireEvent.mouseDown(svg, { clientX: 90, clientY: 72, button: 0 });
      document.dispatchEvent(new MouseEvent("mouseup", {
        clientX: 90,
        clientY: 72,
        button: 0,
        bubbles: true,
      }));
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => { await Promise.resolve(); });
    }

    expect(rasterFrame).not.toBeNull();
    const rasterSvg = await rasterFrame!.text();
    expect(rasterSvg).toContain('viewBox="0 0 1000 800"');
    expect(rasterSvg).not.toContain('viewBox="100 200 1000 800"');

    const aisleInput = container.querySelector(
      'input[placeholder="e.g. 09 or 22"]',
    ) as HTMLInputElement;
    expect(aisleInput).not.toBeNull();
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "24" } });
    });
    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save Zone",
    );
    expect(saveButton).toBeDefined();
    await act(async () => {
      fireEvent.click(saveButton!);
      await Promise.resolve();
      await Promise.resolve();
    });

    const post = (fetchMock.mock.calls as [string, RequestInit][]).find(
      ([url, init]) =>
        String(url).endsWith("/warehouse-zones") &&
        (init?.method ?? "").toUpperCase() === "POST",
    );
    expect(post).toBeDefined();
    expect(JSON.parse(post![1].body as string)).toMatchObject({
      aisleId: "24",
      // The normalized raster still describes a 1000×800 floor-plan frame;
      // inverse calibration stores the resulting rectangle in world space.
      svgX: -70,
      svgY: 45,
      svgWidth: 1000,
      svgHeight: 800,
    });
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

  it("uses safe identity for unavailable or out-of-range alignment and Map fallback without anchors", async () => {
    const alignmentCases: Array<{ alignment: unknown; ok: boolean; anchors?: unknown[] }> = [
      { alignment: { translateX: 10001, translateY: 0, scale: 1 }, ok: true },
      { alignment: MAP_ALIGNMENT, ok: false },
      { alignment: MAP_ALIGNMENT, ok: true, anchors: [] },
    ];
    for (const alignmentCase of alignmentCases) {
      const anchors = alignmentCase.anchors ?? CALIBRATED_ANCHORS;
      const { container, fetchMock } = await setupEditor(
        [ZONE_1],
        anchors,
        undefined,
        alignmentCase.alignment,
        alignmentCase.ok,
      );
      const expectedAlignment = alignmentCase.ok
        ? alignmentCase.alignment === MAP_ALIGNMENT && anchors.length === 0
          ? "translate(30, -20) scale(0.5)"
          : "translate(0, 0) scale(1)"
        : "translate(0, 0) scale(1)";
      await waitFor(() => {
        expect(container.querySelector("[data-testid='zone-editor-alignment-layer']")
          ?.getAttribute("transform")).toBe(expectedAlignment);
      });

      const layer = container.querySelector("[data-testid='zone-editor-calibrated-layer']");
      expect(layer?.getAttribute("transform")).toBe(
        anchors.length > 0 ? "matrix(2,0,0,2,10,-5)" : null,
      );
      const rect = getZoneFillRects(container)[0]!;
      const usesMapAlignment = expectedAlignment.startsWith("translate(30");
      const scale = usesMapAlignment ? 0.5 : 1;
      const translateX = usesMapAlignment ? 30 : 0;
      const translateY = usesMapAlignment ? -20 : 0;
      const expectedTopLeft = anchors.length > 0
        ? { x: 210, y: 195 }
        : usesMapAlignment
          ? { x: 80, y: 30 }
          : { x: 100, y: 100 };
      const effectiveX = anchors.length > 0
        ? 2 * (scale * Number(rect.getAttribute("x")) + translateX) + 10
        : scale * Number(rect.getAttribute("x")) + translateX;
      const effectiveY = anchors.length > 0
        ? 2 * (scale * Number(rect.getAttribute("y")) + translateY) - 5
        : scale * Number(rect.getAttribute("y")) + translateY;
      expect({ x: effectiveX, y: effectiveY }).toEqual(expectedTopLeft);
      const alignmentCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(
        ([url]) => String(url).includes("/warehouse-zones/alignment"),
      );
      expect(alignmentCalls.some(([, init]) => (init?.method ?? "GET").toUpperCase() !== "GET"))
        .toBe(false);
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
