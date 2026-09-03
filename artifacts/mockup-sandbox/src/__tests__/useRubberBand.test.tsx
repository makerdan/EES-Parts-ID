/**
 * useRubberBand.test.tsx
 *
 * Integration tests for the useRubberBand hook as exercised through the
 * full ZoneEditor component.  Mouse gestures are driven at the DOM level;
 * selection state is verified via the SVG zone rectangles (stroke colour)
 * and the sidebar zone-list items (border-left colour).
 *
 * Coordinate system (INITIAL_SCALE = 0.18, getBCR returns left=top=0):
 *   screenToSvg(cx, cy) = { x: cx / 0.18, y: cy / 0.18 }
 *
 * ZONE_1:  svgX=100  svgY=100  svgWidth=200  svgHeight=150
 * ZONE_2:  svgX=400  svgY=100  svgWidth=200  svgHeight=150
 *
 * To cover ZONE_1 with a rubber-band (and NOT ZONE_2):
 *   mousedown (5,5)   → svgPt ≈ (27.8, 27.8)  — before zone top-left
 *   mousemove (65,60) → svgPt ≈ (361, 333)    — past ZONE_1 right edge (300)
 *                                                 but still left of ZONE_2 left edge (400)
 *
 * To cover both ZONE_1 and ZONE_2:
 *   mousedown (5,5) / mousemove (130, 60) → svgPt ≈ (722, 333)
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
  within,
} from "@testing-library/react";
import { ZoneEditor } from "../pages/ZoneEditor";

// ── Zone fixtures ──────────────────────────────────────────────────────────────

const ZONE_1 = {
  id: 1, aisleId: "12", sectionNum: 1,
  isInventory: true, svgX: 100, svgY: 100, svgWidth: 200, svgHeight: 150, sortOrder: 0,
};
const ZONE_2 = {
  id: 2, aisleId: "13", sectionNum: 1,
  isInventory: true, svgX: 400, svgY: 100, svgWidth: 200, svgHeight: 150, sortOrder: 1,
};

// ── Fetch mock factory ─────────────────────────────────────────────────────────

function makeFetchMock(
  zones: typeof ZONE_1[] = [ZONE_1],
  patchStatus = 200,
) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const s = String(url);

    if (method === "GET" && s.includes("/floor-plan/svg"))
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });

    if (method === "GET" && s.includes("/warehouse-zones/coverage"))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }), text: () => Promise.resolve("") });

    if (s.includes("/warehouse-zones/alignment"))
      throw new Error(`unexpected alignment fetch: ${s}`);

    if (method === "GET" && s.includes("/warehouse-zones"))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ zones }), text: () => Promise.resolve("") });

    if (method === "PATCH")
      return Promise.resolve({
        ok: patchStatus === 200,
        status: patchStatus,
        json: () => Promise.resolve(patchStatus === 200 ? {} : { error: `HTTP ${patchStatus}` }),
        text: () => Promise.resolve(""),
      });

    if (method === "POST" && s.includes("/warehouse-zones"))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ zone: { ...ZONE_1, id: 99 } }), text: () => Promise.resolve("") });

    if (method === "DELETE")
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
  });
}

// ── Render helper ──────────────────────────────────────────────────────────────

async function setupEditor(zones: typeof ZONE_1[] = [ZONE_1], patchStatus = 200) {
  const fetchMock = makeFetchMock(zones, patchStatus);
  global.fetch = fetchMock as unknown as typeof global.fetch;

  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ZoneEditor />));
  });

  const svgEl = container.querySelector("svg") as SVGSVGElement;
  vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 800, bottom: 600,
    width: 800, height: 600, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  return { container, svgEl, fetchMock };
}

// ── Rubber-band gesture helpers ────────────────────────────────────────────────

/** Fire a Shift+drag rubber-band gesture on the SVG background. */
async function rubberBand(
  svgEl: SVGSVGElement,
  from: { clientX: number; clientY: number },
  to: { clientX: number; clientY: number },
) {
  await act(async () => {
    fireEvent.mouseDown(svgEl, { ...from, button: 0, shiftKey: true });
  });
  await act(async () => {
    document.dispatchEvent(new MouseEvent("mousemove", { ...to, bubbles: true }));
  });
  await act(async () => {
    document.dispatchEvent(new MouseEvent("mouseup", { ...to, bubbles: true }));
  });
  // Drain any microtask/state flush
  await act(async () => { await Promise.resolve(); });
}

// Coordinates that cover ZONE_1 only (svgX2 = 65/0.18 ≈ 361, < ZONE_2 left edge 400)
const DRAG_Z1 = { from: { clientX: 5, clientY: 5 }, to: { clientX: 65, clientY: 60 } };
// Coordinates that cover both ZONE_1 and ZONE_2
const DRAG_BOTH = { from: { clientX: 5, clientY: 5 }, to: { clientX: 130, clientY: 60 } };
// Coordinates that cover ZONE_2 only.
// Start at clientX=59 → svgX ≈ 328 (gap between zones, 300–400), so ZONE_1 (100–300) right
// edge (300) does NOT exceed the rect start (328) and is excluded from the hit set.
// End at clientX=110 → svgX ≈ 611, past ZONE_2 right edge (600).
const DRAG_Z2 = { from: { clientX: 59, clientY: 5 }, to: { clientX: 110, clientY: 60 } };

// ── DOM helpers ────────────────────────────────────────────────────────────────

/** Zone fill rects (isInventory blue) */
function getZoneFillRects(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll("rect")].filter(
    (r) => r.getAttribute("fill")?.startsWith("rgba(0, 112, 255"),
  ) as SVGRectElement[];
}

/** Returns zone fill rects that currently have the selection (amber) stroke. */
function getSelectedZoneRects(container: HTMLElement): SVGRectElement[] {
  return getZoneFillRects(container).filter(
    (r) => r.getAttribute("stroke") === "#f59e0b",
  );
}

/** Returns true if the rubber-rect element exists and has non-zero dimensions. */
function rubberRectVisible(container: HTMLElement): boolean {
  const r = [...container.querySelectorAll("rect")].find(
    (r) => r.getAttribute("stroke") === "#3b82f6",
  );
  if (!r) return false;
  return Number(r.getAttribute("width") ?? 0) > 0 && Number(r.getAttribute("height") ?? 0) > 0;
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe("useRubberBand — Zone Editor integration", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("Shift+drag over a zone selects it", async () => {
    const { container, svgEl } = await setupEditor();
    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    expect(getSelectedZoneRects(container)).toHaveLength(1);
  });

  it("Shift+drag over two zones selects both", async () => {
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);
    await rubberBand(svgEl, DRAG_BOTH.from, DRAG_BOTH.to);
    expect(getSelectedZoneRects(container)).toHaveLength(2);
  });

  it("second Shift+drag is additive — does not deselect zones from the prior drag", async () => {
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    // First rubber-band selects both zones
    await rubberBand(svgEl, DRAG_BOTH.from, DRAG_BOTH.to);
    expect(getSelectedZoneRects(container)).toHaveLength(2);

    // Second rubber-band covers only ZONE_1 — additive, so ZONE_2 must remain selected
    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    expect(getSelectedZoneRects(container)).toHaveLength(2);
  });

  // ── Additive (Shift = union) behavior ────────────────────────────────────────

  it("Shift+drag over a disjoint zone adds it to the existing selection", async () => {
    // Design: Shift is an ADDITIVE modifier. The rubber-band unions new hits with
    // the existing selection so that previously-selected zones are never lost.
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    // Step 1: select ZONE_1 via rubber-band
    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    expect(getSelectedZoneRects(container)).toHaveLength(1);

    // Step 2: rubber-band covers only ZONE_2 (starts in the gap between zones)
    // Under the old replace-semantics this would give {ZONE_2} (ZONE_1 lost).
    // With additive semantics both zones must be selected.
    await rubberBand(svgEl, DRAG_Z2.from, DRAG_Z2.to);
    expect(getSelectedZoneRects(container)).toHaveLength(2);
  });

  it("drag starting inside an already-selected zone preserves it alongside any new hits", async () => {
    // Specific scenario from the bug: user has zones A and B selected, starts a
    // Shift+drag from inside A (intending to widen the selection) but the
    // rubber-band rect only captures A — B must not be silently deselected.
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    // Both zones selected via a wide drag
    await rubberBand(svgEl, DRAG_BOTH.from, DRAG_BOTH.to);
    expect(getSelectedZoneRects(container)).toHaveLength(2);

    // Start from inside ZONE_1 (clientX=30 → svgX≈167), end before ZONE_2 left
    // edge — rubber rect covers ZONE_1 only, so ZONE_2 would be dropped under
    // replace semantics.  With additive semantics ZONE_2 must stay selected.
    await rubberBand(
      svgEl,
      { clientX: 30, clientY: 5 },
      { clientX: 65, clientY: 60 },
    );
    expect(getSelectedZoneRects(container)).toHaveLength(2);
  });

  it("rubberRect is cleared (not visible) after mouseup", async () => {
    const { container, svgEl } = await setupEditor();
    // During drag the rubber rect should become visible
    await act(async () => {
      fireEvent.mouseDown(svgEl, { clientX: 5, clientY: 5, button: 0, shiftKey: true });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, clientY: 60, bubbles: true }));
    });
    expect(rubberRectVisible(container)).toBe(true);

    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 80, clientY: 60, bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    // After mouseup the rubber rect must be gone
    expect(rubberRectVisible(container)).toBe(false);
  });

  // ── Empty state ──────────────────────────────────────────────────────────────

  it("drag over an area with no zones leaves selectedIds empty", async () => {
    const { container, svgEl } = await setupEditor([]);
    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    expect(getSelectedZoneRects(container)).toHaveLength(0);
  });

  // ── Overflow / boundary ──────────────────────────────────────────────────────

  it("drag with very large SVG coordinates does not throw", async () => {
    const { container, svgEl } = await setupEditor();
    await expect(
      rubberBand(
        svgEl,
        { clientX: 0, clientY: 0 },
        { clientX: 2000, clientY: 2000 },
      ),
    ).resolves.not.toThrow();
    // Large drag still covers ZONE_1
    expect(getSelectedZoneRects(container)).toHaveLength(1);
  });

  it("drag starting at the SVG edge (0,0) works correctly", async () => {
    const { container, svgEl } = await setupEditor();
    await rubberBand(svgEl, { clientX: 0, clientY: 0 }, { clientX: 80, clientY: 60 });
    expect(getSelectedZoneRects(container)).toHaveLength(1);
  });

  it("0-px drag (mousedown == mouseup position) leaves selection empty", async () => {
    const { container, svgEl } = await setupEditor();
    await rubberBand(svgEl, { clientX: 5, clientY: 5 }, { clientX: 5, clientY: 5 });
    expect(getSelectedZoneRects(container)).toHaveLength(0);
  });

  // ── Unexpected shape — malformed API data ────────────────────────────────────

  it("editor renders without crashing when API returns zones with missing coordinates", async () => {
    const malformedZones = [
      { id: 1, aisleId: "12", sectionNum: 1, isInventory: true, sortOrder: 0 } as typeof ZONE_1,
    ];
    const { container, svgEl } = await setupEditor(malformedZones);
    // Rubber band over the area where the zone would have been — should not crash
    await expect(
      rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to),
    ).resolves.not.toThrow();
    // No zones with valid geometry means no selection
    expect(getSelectedZoneRects(container)).toHaveLength(0);
  });

  // ── Failure — fetch 500 ──────────────────────────────────────────────────────

  it("shows a branded error banner when the zone-list fetch returns 500", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    // The branded error banner (not a raw "Error:" string) should appear
    await waitFor(() => {
      expect(container.textContent).toMatch(/Failed to load zones/i);
    });
    // Should not show a raw JS Error
    expect(container.textContent).not.toMatch(/^Error:/);
  });

  it("rubber-band is not reachable while the zone list is in error state (no canvas zones)", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Failed to load zones/i);
    });

    const svgEl = container.querySelector("svg") as SVGSVGElement;
    vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    // No zones loaded → nothing to select
    expect(getSelectedZoneRects(container)).toHaveLength(0);
  });

  // ── Failure — network timeout ────────────────────────────────────────────────

  it("shows a branded error surface when fetch rejects with a network error (TypeError)", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/Failed to load zones/i);
    });
    expect(container.textContent).not.toMatch(/^TypeError:/);
  });

  // ── Failure — 500 during background save while rubber-band fires ─────────────

  it("rubber-band selection is not corrupted when a background PATCH returns 500", async () => {
    const { container, svgEl, fetchMock } = await setupEditor([ZONE_1, ZONE_2], 500);

    // Trigger a zone move (which fires a PATCH that will 500)
    const zoneFillRects = getZoneFillRects(container);
    await act(async () => {
      fireEvent.mouseDown(zoneFillRects[0]!, { clientX: 36, clientY: 31, button: 0 });
    });
    // Immediately start a rubber-band on the SVG background while move is in-flight
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 150, clientY: 120, bubbles: true }));
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 150, clientY: 120, bubbles: true }));
    });
    // Let the PATCH settle (it will fail and show a toast)
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Now fire a rubber-band covering both zones; selection state should still work
    await rubberBand(svgEl, DRAG_BOTH.from, DRAG_BOTH.to);

    await waitFor(() => {
      expect(getSelectedZoneRects(container).length).toBeGreaterThanOrEqual(1);
    });

    // fetchMock was called (PATCH attempt happened)
    const patchCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(
      ([, init]) => (init?.method ?? "").toUpperCase() === "PATCH",
    );
    expect(patchCalls.length).toBeGreaterThan(0);
  });

  // ── Timing — slow load ───────────────────────────────────────────────────────

  it("loading indicator is visible before zones load, zones are selectable after", async () => {
    let resolveZones!: (v: unknown) => void;
    const slowFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const s = String(url);
      if (method === "GET" && s.includes("/floor-plan/svg"))
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });
      if (method === "GET" && s.includes("/warehouse-zones/coverage"))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }), text: () => Promise.resolve("") });
      if (s.includes("/warehouse-zones/alignment"))
        throw new Error(`unexpected alignment fetch: ${s}`);
      if (method === "GET" && s.includes("/warehouse-zones"))
        return new Promise((res) => {
          resolveZones = res as (v: unknown) => void;
        });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
    });
    global.fetch = slowFetch as unknown as typeof global.fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    // Loading indicator must be present while fetch is in-flight
    expect(container.textContent).toMatch(/Loading zones/i);

    // Now resolve the fetch
    await act(async () => {
      resolveZones({ ok: true, status: 200, json: () => Promise.resolve({ zones: [ZONE_1] }), text: () => Promise.resolve("") });
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    // After load, zones are visible and selectable via rubber-band
    const svgEl = container.querySelector("svg") as SVGSVGElement;
    vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    await waitFor(() => {
      expect(getZoneFillRects(container)).toHaveLength(1);
    });

    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    expect(getSelectedZoneRects(container)).toHaveLength(1);
  });

  // ── Timing — rapid consecutive drags ────────────────────────────────────────

  it("three consecutive Shift+drags accumulate — all previously selected zones are retained", async () => {
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    // Drag 1: select ZONE_1 → {1}
    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    // Drag 2: add both → {1, 2}
    await rubberBand(svgEl, DRAG_BOTH.from, DRAG_BOTH.to);
    // Drag 3: covers ZONE_1 only → additive union keeps {1, 2}
    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);

    // All accumulated zones must remain selected
    expect(getSelectedZoneRects(container)).toHaveLength(2);
  });

  it("no zombie document listeners remain after rapid drags", async () => {
    const { svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    await rubberBand(svgEl, DRAG_BOTH.from, DRAG_BOTH.to);
    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);

    const mouseAdditions = addSpy.mock.calls.filter(
      ([ev]) => ev === "mousemove" || ev === "mouseup",
    );
    const mouseRemovals = removeSpy.mock.calls.filter(
      ([ev]) => ev === "mousemove" || ev === "mouseup",
    );
    // Every listener added must be removed
    expect(mouseRemovals.length).toBeGreaterThanOrEqual(mouseAdditions.length);
  });

  // ── Timing — unmount mid-drag ────────────────────────────────────────────────

  it("unmounting during a drag does not leave lingering document listeners", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    let container!: HTMLElement;
    let unmount!: () => void;
    const fetchMock = makeFetchMock([ZONE_1]);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await act(async () => {
      ({ container, unmount } = render(<ZoneEditor />));
    });

    const svgEl = container.querySelector("svg") as SVGSVGElement;
    vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    // Start a drag…
    await act(async () => {
      fireEvent.mouseDown(svgEl, { clientX: 5, clientY: 5, button: 0, shiftKey: true });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 40, bubbles: true }));
    });

    // …then unmount without completing the drag
    await act(async () => {
      unmount();
    });

    const mouseAdditions = addSpy.mock.calls.filter(
      ([ev]) => ev === "mousemove" || ev === "mouseup",
    );
    const mouseRemovals = removeSpy.mock.calls.filter(
      ([ev]) => ev === "mousemove" || ev === "mouseup",
    );
    // Unmount cleanup must have removed the listeners
    expect(mouseRemovals.length).toBeGreaterThanOrEqual(mouseAdditions.length);
  });

  // ── Permissions — session expired (401) ─────────────────────────────────────

  it("surfaces a session-expired load error (no crash) when the zone fetch returns 401", async () => {
    // Auth is now handled by <AdminGate> (Clerk) upstream, so ZoneEditor no longer
    // renders a login form. A 401 mid-session means the Clerk cookie expired — the
    // editor should surface a clear load error rather than crashing.
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    // The editor surfaces a load error instead of crashing.
    await waitFor(() => {
      expect(within(container).getByText(/Failed to load zones/i)).toBeTruthy();
    });
  });

  // ── Permissions — read-only role ─────────────────────────────────────────────

  it("rubber-band does not crash when no zones are loaded (functionally read-only state)", async () => {
    // When the API returns an empty list (or fails), the editor is effectively
    // read-only for rubber-band purposes: no zones → no selection changes.
    const { container, svgEl } = await setupEditor([]);

    await expect(
      rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to),
    ).resolves.not.toThrow();

    expect(getSelectedZoneRects(container)).toHaveLength(0);
  });

  // ── Concurrency — double mousedown ──────────────────────────────────────────

  it("second mousedown before mouseup: second drag wins, only one listener set remains", async () => {
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    // First mousedown — drag starts
    await act(async () => {
      fireEvent.mouseDown(svgEl, { clientX: 5, clientY: 5, button: 0, shiftKey: true });
    });
    // Second mousedown before first mouseup — hook should cancel first and start second
    await act(async () => {
      fireEvent.mouseDown(svgEl, { clientX: 5, clientY: 5, button: 0, shiftKey: true });
    });
    // Mouseup completes the second drag covering ZONE_1 + ZONE_2
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 130, clientY: 60, bubbles: true }));
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 130, clientY: 60, bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    // Selection should reflect the second drag
    expect(getSelectedZoneRects(container)).toHaveLength(2);

    // The number of removals must >= additions — no orphaned listeners
    const additions = addSpy.mock.calls.filter(
      ([ev]) => ev === "mousemove" || ev === "mouseup",
    ).length;
    const removals = removeSpy.mock.calls.filter(
      ([ev]) => ev === "mousemove" || ev === "mouseup",
    ).length;
    expect(removals).toBeGreaterThanOrEqual(additions);
  });

  // ── Loading state visible ─────────────────────────────────────────────────────

  it("loading indicator is rendered while the zone list fetch is in flight", async () => {
    let resolveZones!: (v: unknown) => void;
    const slowFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const s = String(url);
      if (method === "GET" && s.includes("/floor-plan/svg"))
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });
      if (method === "GET" && s.includes("/warehouse-zones/coverage"))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }), text: () => Promise.resolve("") });
      if (method === "GET" && s.includes("/warehouse-zones/alignment"))
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      if (method === "GET" && s.includes("/warehouse-zones"))
        return new Promise((res) => { resolveZones = res as (v: unknown) => void; });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
    });
    global.fetch = slowFetch as unknown as typeof global.fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    expect(container.textContent).toMatch(/Loading zones/i);

    await act(async () => {
      resolveZones({ ok: true, status: 200, json: () => Promise.resolve({ zones: [ZONE_1] }), text: () => Promise.resolve("") });
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    await waitFor(() => {
      expect(container.textContent).not.toMatch(/Loading zones/i);
    });
  });

  // ── Error state branded ───────────────────────────────────────────────────────

  it("error banner uses branded copy, not a raw Error string", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/Failed to load zones/i);
    });

    // Must not expose raw "Error:" prefix
    expect(container.textContent).not.toMatch(/^Error:/);
    // Must not expose a raw status code in a non-branded way
    expect(container.textContent).not.toMatch(/Uncaught/);
  });

  // ── Empty state visible ───────────────────────────────────────────────────────

  it("shows a no-zones indicator when the API returns an empty zone array", async () => {
    const { container } = await setupEditor([]);

    await waitFor(() => {
      // The zone-list section should show the empty-state message, not a blank page
      expect(container.textContent).toMatch(/No zones yet/i);
    });
  });

  // ── Escape key — clear selection ─────────────────────────────────────────────

  it("pressing Escape deselects all selected zones", async () => {
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    // Select both zones via rubber-band
    await rubberBand(svgEl, DRAG_BOTH.from, DRAG_BOTH.to);
    expect(getSelectedZoneRects(container)).toHaveLength(2);

    // Press Escape — selection must be cleared
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(getSelectedZoneRects(container)).toHaveLength(0);
  });

  it("pressing Escape when nothing is selected does not crash and leaves selection empty", async () => {
    const { container } = await setupEditor([ZONE_1]);

    // No selection yet — Escape should be a no-op
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(getSelectedZoneRects(container)).toHaveLength(0);
  });

  it("Escape is ignored when focus is inside a text input", async () => {
    const { container, svgEl } = await setupEditor([ZONE_1]);

    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    expect(getSelectedZoneRects(container)).toHaveLength(1);

    // Move focus into a text input and press Escape
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // Selection must still be intact — text-field focus blocks the shortcut
    expect(getSelectedZoneRects(container)).toHaveLength(1);

    document.body.removeChild(input);
  });

  it("Escape listener is cleaned up when the component unmounts (no lingering window listeners)", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    let unmount!: () => void;
    const fetchMock = makeFetchMock([ZONE_1]);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await act(async () => {
      ({ unmount } = render(<ZoneEditor />));
    });

    // Capture how many "keydown" listeners were added during mount
    const keydownAdditions = addSpy.mock.calls.filter(([ev]) => ev === "keydown").length;

    await act(async () => { unmount(); });

    const keydownRemovals = removeSpy.mock.calls.filter(([ev]) => ev === "keydown").length;

    // Every keydown listener added must be removed on unmount
    expect(keydownRemovals).toBeGreaterThanOrEqual(keydownAdditions);
  });

  // ── Shift+click individual zone toggle ───────────────────────────────────────

  it("Shift+click a selected zone removes only that zone from the selection", async () => {
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    // Rubber-band both zones into the selection
    await rubberBand(svgEl, DRAG_BOTH.from, DRAG_BOTH.to);
    expect(getSelectedZoneRects(container)).toHaveLength(2);

    // Shift+click the first zone rect to deselect it
    const zoneRects = getZoneFillRects(container);
    await act(async () => {
      fireEvent.mouseDown(zoneRects[0]!, { button: 0, shiftKey: true, clientX: 36, clientY: 31 });
    });
    await act(async () => { await Promise.resolve(); });

    // Only the second zone should remain selected
    expect(getSelectedZoneRects(container)).toHaveLength(1);
  });

  it("Shift+click an unselected zone adds only that zone to the selection", async () => {
    const { container, svgEl } = await setupEditor([ZONE_1, ZONE_2]);

    // Start with ZONE_1 selected via rubber-band
    await rubberBand(svgEl, DRAG_Z1.from, DRAG_Z1.to);
    expect(getSelectedZoneRects(container)).toHaveLength(1);

    // Shift+click the second zone rect (ZONE_2, which is not yet selected)
    const zoneRects = getZoneFillRects(container);
    await act(async () => {
      fireEvent.mouseDown(zoneRects[1]!, { button: 0, shiftKey: true, clientX: 90, clientY: 31 });
    });
    await act(async () => { await Promise.resolve(); });

    // Both zones should now be selected
    expect(getSelectedZoneRects(container)).toHaveLength(2);
  });
});
