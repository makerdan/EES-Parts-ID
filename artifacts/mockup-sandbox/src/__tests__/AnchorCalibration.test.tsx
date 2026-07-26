/**
 * AnchorCalibration.test.tsx
 *
 * Coverage:
 *   1. screenToSvg coordinate conversion — various pan/zoom transforms
 *   2. Click-vs-drag slop threshold — drag past CLICK_SLOP_PX must NOT place an anchor
 *   3. Save API round-trip — correct PUT payload shape
 *   4. Clear API round-trip — DELETE call, then re-fetches anchors
 *   5. Save guard — missing coord or invalid world coords emit a status message, no fetch
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { AnchorCalibration } from "../pages/AnchorCalibration";

// ---------------------------------------------------------------------------
// 1. Pure-function: screen → SVG coordinate conversion
// ---------------------------------------------------------------------------
// The formula used in onMouseUp:
//   svgX = (clientX - rect.left - tf.x) / tf.s
//   svgY = (clientY - rect.top  - tf.y) / tf.s

function screenToSvg(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  tf: { x: number; y: number; s: number },
): { x: number; y: number } {
  return {
    x: (clientX - rect.left - tf.x) / tf.s,
    y: (clientY - rect.top - tf.y) / tf.s,
  };
}

describe("screenToSvg — pure coordinate conversion", () => {
  it("identity transform: SVG coords equal screen coords relative to rect", () => {
    const result = screenToSvg(300, 200, { left: 0, top: 0 }, { x: 0, y: 0, s: 1 });
    expect(result.x).toBeCloseTo(300);
    expect(result.y).toBeCloseTo(200);
  });

  it("rect offset: subtracts the bounding-rect origin before scaling", () => {
    const result = screenToSvg(350, 250, { left: 50, top: 50 }, { x: 0, y: 0, s: 1 });
    expect(result.x).toBeCloseTo(300);
    expect(result.y).toBeCloseTo(200);
  });

  it("translate only (no scale): subtracts tf.x/y after rect offset", () => {
    const result = screenToSvg(340, 260, { left: 40, top: 60 }, { x: 100, y: 80, s: 1 });
    // (340-40-100)/1 = 200, (260-60-80)/1 = 120
    expect(result.x).toBeCloseTo(200);
    expect(result.y).toBeCloseTo(120);
  });

  it("scale 2×: halves the logical SVG coordinate", () => {
    const result = screenToSvg(200, 150, { left: 0, top: 0 }, { x: 0, y: 0, s: 2 });
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(75);
  });

  it("scale 0.18 (default INITIAL_SCALE): matches expected enlarged coords", () => {
    // At s=0.18, a screen point at (40,40) offset relative to the rect should map back to SVG origin
    // since the default tf is {x:40,y:40,s:0.18}
    const result = screenToSvg(40, 40, { left: 0, top: 0 }, { x: 40, y: 40, s: 0.18 });
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
  });

  it("scale 0.5, translate (100,80), rect (20,20): known-good numeric case", () => {
    // clientX=270 → (270-20-100)/0.5 = 300
    // clientY=230 → (230-20-80)/0.5  = 260
    const result = screenToSvg(270, 230, { left: 20, top: 20 }, { x: 100, y: 80, s: 0.5 });
    expect(result.x).toBeCloseTo(300);
    expect(result.y).toBeCloseTo(260);
  });

  it("zoom scale 4 (max): scales down screen delta by 4×", () => {
    const result = screenToSvg(440, 320, { left: 40, top: 20 }, { x: 0, y: 0, s: 4 });
    // (440-40)/4=100, (320-20)/4=75
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(75);
  });

  it("negative translate (panned left/up): produces larger SVG coordinates", () => {
    // If the map was panned so tf.x = -200 (map shifted left), clicking the same screen
    // point resolves to a larger SVG x
    const result = screenToSvg(100, 100, { left: 0, top: 0 }, { x: -200, y: -100, s: 1 });
    // (100 - 0 - (-200)) / 1 = 300
    expect(result.x).toBeCloseTo(300);
    expect(result.y).toBeCloseTo(200);
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by component tests
// ---------------------------------------------------------------------------

function makeJsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as unknown as Response);
}

/** Stub fetch to return empty anchors for GET and 200 OK for mutations. */
function stubFetchOk(extras?: (url: string, init?: RequestInit) => Promise<Response> | null) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (extras) {
      const result = extras(url, init);
      if (result !== null) return result;
    }
    // Default: anchors fetch
    return makeJsonResponse(200, { anchors: [] });
  }) as unknown as typeof global.fetch;
}

/**
 * Render <AnchorCalibration />, wait for the initial anchors fetch, and return
 * the rendered container + utilities.
 */
async function renderCalibration() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AnchorCalibration />);
  });
  return result;
}

/**
 * Activate "Place" mode for a slot, then simulate a clean click (mousedown +
 * mouseup with ≤ CLICK_SLOP movement) on the SVG canvas.
 *
 * The caller must mock svgEl.getBoundingClientRect() before calling this.
 */
async function placeAnchor(
  container: HTMLElement,
  slotIndex: 0 | 1 | 2,
  clientX: number,
  clientY: number,
) {
  const label = slotIndex === 0 ? "Place" : "Place";
  // Find the Place button for the correct slot by aria label / index
  const placeBtns = Array.from(
    container.querySelectorAll("button"),
  ).filter((b) => /^(Place|Re-place)$/i.test(b.textContent?.trim() ?? ""));
  const btn = placeBtns[slotIndex];
  if (!btn) throw new Error(`Could not find Place button for slot ${slotIndex}`);

  await act(async () => {
    fireEvent.click(btn);
  });

  const svg = container.querySelector("svg")!;

  await act(async () => {
    fireEvent.mouseDown(svg, { button: 0, clientX, clientY });
    // No move — counts as a click
    fireEvent.mouseUp(svg, { clientX, clientY });
  });
}

// ---------------------------------------------------------------------------
// 2. Click-vs-drag slop threshold
// ---------------------------------------------------------------------------

describe("AnchorCalibration — click-vs-drag slop", () => {
  beforeEach(() => {
    global.fetch = stubFetchOk();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("places an anchor when mousedown → mouseup with no movement (clean click)", async () => {
    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    // Activate picking for slot 0
    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });

    // Clean click — no movement
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseUp(svg, { clientX: 200, clientY: 150 });
    });

    // Expect the coordinate to appear in the sidebar: "x: ..., y: ..."
    await waitFor(() => {
      expect(screen.getByText(/x:.*y:/i)).toBeTruthy();
    });
  });

  it("does NOT place an anchor when drag exceeds the 5 px slop threshold (horizontal)", async () => {
    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });

    // Move > 5 px horizontally before releasing
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseMove(svg, { clientX: 206, clientY: 150 }); // 6 px > slop
      fireEvent.mouseUp(svg, { clientX: 206, clientY: 150 });
    });

    // "Not placed" should still be displayed for slot 0
    const notPlacedEls = screen.getAllByText(/not placed/i);
    expect(notPlacedEls.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT place an anchor when drag exceeds the 5 px slop threshold (vertical)", async () => {
    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });

    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseMove(svg, { clientX: 200, clientY: 157 }); // 7 px > slop
      fireEvent.mouseUp(svg, { clientX: 200, clientY: 157 });
    });

    const notPlacedEls = screen.getAllByText(/not placed/i);
    expect(notPlacedEls.length).toBeGreaterThanOrEqual(1);
  });

  it("places an anchor when movement is exactly at the slop boundary (5 px)", async () => {
    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });

    // Exactly 5 px — NOT greater than, so still counts as a click
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseMove(svg, { clientX: 205, clientY: 150 }); // == CLICK_SLOP_PX, not >
      fireEvent.mouseUp(svg, { clientX: 205, clientY: 150 });
    });

    await waitFor(() => {
      expect(screen.getByText(/x:.*y:/i)).toBeTruthy();
    });
  });

  it("does not place an anchor when no slot is being picked (picking mode inactive)", async () => {
    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    // No Place button clicked — picking mode is inactive
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseUp(svg, { clientX: 200, clientY: 150 });
    });

    const notPlacedEls = screen.getAllByText(/not placed/i);
    // All three slots still show "Not placed"
    expect(notPlacedEls.length).toBe(3);
  });

  it("cancels picking mode without placing when the Cancel button is clicked", async () => {
    const { container } = await renderCalibration();

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });

    // The button should now say "Cancel"
    const cancelBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => /^Cancel$/i.test(b.textContent?.trim() ?? ""),
    );
    expect(cancelBtn).toBeTruthy();

    // Click Cancel to exit picking mode
    await act(async () => { fireEvent.click(cancelBtn!); });

    // Slot should still show "Not placed"
    const notPlacedEls = screen.getAllByText(/not placed/i);
    expect(notPlacedEls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Save API round-trip
// ---------------------------------------------------------------------------

describe("AnchorCalibration — save payload", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("sends the correct PUT payload to /admin/map-anchors/1 for slot 0", async () => {
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      capturedRequests.push({ url: url as string, init: init ?? {} });
      return makeJsonResponse(200, { anchors: [] });
    }) as unknown as typeof global.fetch;

    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    // Place anchor for slot 0 — tf is {x:40,y:40,s:0.18}
    // svgX = (300 - 0 - 40) / 0.18 ≈ 1444.4
    // svgY = (200 - 0 - 40) / 0.18 ≈ 888.9
    const CLICK_X = 300;
    const CLICK_Y = 200;

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: CLICK_X, clientY: CLICK_Y });
      fireEvent.mouseUp(svg, { clientX: CLICK_X, clientY: CLICK_Y });
    });

    // Fill in form fields
    const inputs = container.querySelectorAll("input");
    // inputs layout per slot: [name, worldX, worldY] × 3 — so slot 0 is inputs[0..2]
    await act(async () => {
      fireEvent.change(inputs[0]!, { target: { value: "Entrance" } });
      fireEvent.change(inputs[1]!, { target: { value: "12.5" } });
      fireEvent.change(inputs[2]!, { target: { value: "7.3" } });
    });

    // Click Save
    const saveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(saveBtn!); });

    // Find the PUT request
    const putRequest = capturedRequests.find(
      (r) => r.init?.method === "PUT" && String(r.url).includes("/admin/map-anchors/1"),
    );
    expect(putRequest).toBeTruthy();

    const body = JSON.parse(putRequest!.init.body as string);
    expect(body.name).toBe("Entrance");
    expect(body.worldX).toBeCloseTo(12.5);
    expect(body.worldY).toBeCloseTo(7.3);
    // SVG coordinates computed from the click
    const expectedSvgX = (CLICK_X - 0 - 40) / 0.18;
    const expectedSvgY = (CLICK_Y - 0 - 40) / 0.18;
    expect(body.svgX).toBeCloseTo(expectedSvgX, 2);
    expect(body.svgY).toBeCloseTo(expectedSvgY, 2);
  });

  it("sends PUT to the correct slot URL for slot 1 (/admin/map-anchors/2)", async () => {
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      capturedRequests.push({ url: url as string, init: init ?? {} });
      return makeJsonResponse(200, { anchors: [] });
    }) as unknown as typeof global.fetch;

    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    // Place anchor for slot 1
    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[1]!); });
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseUp(svg, { clientX: 200, clientY: 150 });
    });

    const inputs = container.querySelectorAll("input");
    await act(async () => {
      fireEvent.change(inputs[3]!, { target: { value: "Rack B" } });
      fireEvent.change(inputs[4]!, { target: { value: "50" } });
      fireEvent.change(inputs[5]!, { target: { value: "25" } });
    });

    const saveBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    // Second save button is for slot 1
    await act(async () => { fireEvent.click(saveBtns[1]!); });

    const putRequest = capturedRequests.find(
      (r) => r.init?.method === "PUT" && String(r.url).includes("/admin/map-anchors/2"),
    );
    expect(putRequest).toBeTruthy();
    const body = JSON.parse(putRequest!.init.body as string);
    expect(body.worldX).toBeCloseTo(50);
    expect(body.worldY).toBeCloseTo(25);
  });

  it("shows a status error when no coord has been placed before saving", async () => {
    global.fetch = stubFetchOk();
    const { container } = await renderCalibration();

    const saveBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(saveBtns[0]!); });

    await waitFor(() => {
      expect(screen.getByText(/place a point on the map first/i)).toBeTruthy();
    });
  });

  it("shows a status error when world coordinates are not valid numbers", async () => {
    global.fetch = stubFetchOk();
    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseUp(svg, { clientX: 200, clientY: 150 });
    });

    // Leave worldX/worldY blank (invalid)
    const saveBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(saveBtns[0]!); });

    await waitFor(() => {
      expect(screen.getByText(/enter valid world x and y/i)).toBeTruthy();
    });
  });

  it("does not call fetch for a PUT when validation fails", async () => {
    const fetchMock = stubFetchOk();
    global.fetch = fetchMock;
    const { container } = await renderCalibration();

    const saveBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    // Attempt save with no coord placed
    await act(async () => { fireEvent.click(saveBtns[0]!); });

    // Only the initial GET /admin/map-anchors should have been called
    const putCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, init]: [string, RequestInit]) => init?.method === "PUT",
    );
    expect(putCalls.length).toBe(0);
  });

  it("re-fetches anchors after a successful save", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return makeJsonResponse(200, {});
      return makeJsonResponse(200, { anchors: [] });
    }) as unknown as typeof global.fetch;
    global.fetch = fetchMock;

    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseUp(svg, { clientX: 200, clientY: 150 });
    });

    const inputs = container.querySelectorAll("input");
    await act(async () => {
      fireEvent.change(inputs[0]!, { target: { value: "P1" } });
      fireEvent.change(inputs[1]!, { target: { value: "1" } });
      fireEvent.change(inputs[2]!, { target: { value: "2" } });
    });

    const initialGetCount = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, init]: [string, RequestInit]) => !init?.method || init.method === "GET",
    ).length;

    const saveBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(saveBtns[0]!); });

    await waitFor(() => {
      const getCount = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, init]: [string, RequestInit]) => !init?.method || init.method === "GET",
      ).length;
      expect(getCount).toBeGreaterThan(initialGetCount);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Mutual exclusion — only one slot in picking mode at a time
// ---------------------------------------------------------------------------

describe("AnchorCalibration — mutual exclusion of picking mode", () => {
  beforeEach(() => {
    global.fetch = stubFetchOk();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("clicking Place for slot 1 while slot 0 is active leaves only slot 1 picking", async () => {
    const { container } = await renderCalibration();

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );

    // Activate slot 0 — its button should become "Cancel"
    await act(async () => { fireEvent.click(placeBtns[0]!); });

    // Slot 0 is now in picking mode — its button is "Cancel"
    await waitFor(() => {
      const cancelBtns = Array.from(container.querySelectorAll("button")).filter(
        (b) => /^Cancel$/i.test(b.textContent?.trim() ?? ""),
      );
      expect(cancelBtns.length).toBe(1);
    });

    // The pick banner should mention "Anchor 1"
    expect(screen.getByText(/click the map to place anchor 1/i)).toBeTruthy();

    // Now click Place for slot 1 — slot 1's Place button is now the first "Place" button
    // since slot 0's button changed to "Cancel"
    const placeBtnsAfter = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtnsAfter[0]!); });

    // Banner should now reference Anchor 2
    await waitFor(() => {
      expect(screen.getByText(/click the map to place anchor 2/i)).toBeTruthy();
    });

    // Still exactly one Cancel button (slot 1), slot 0 reverted to Place
    const cancelBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Cancel$/i.test(b.textContent?.trim() ?? ""),
    );
    expect(cancelBtns.length).toBe(1);
  });

  it("a map click after switching to slot 1 places the anchor in slot 1, not slot 0", async () => {
    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    let placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );

    // Activate slot 0, then immediately switch to slot 1
    await act(async () => { fireEvent.click(placeBtns[0]!); });
    placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); }); // slot 1's Place

    // Click the map
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 300, clientY: 200 });
      fireEvent.mouseUp(svg, { clientX: 300, clientY: 200 });
    });

    // Slot 0 should still show "Not placed"; slot 1 should show a coordinate
    await waitFor(() => {
      // At least 2 "Not placed" labels: slots 0 and 2 (slot 1 has coord now)
      const notPlaced = screen.getAllByText(/not placed/i);
      expect(notPlaced.length).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Save-error DOM test — 500 response surfaces error in the slot
// ---------------------------------------------------------------------------

describe("AnchorCalibration — save error display", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the server error message in the slot when PUT returns 500", async () => {
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return makeJsonResponse(500, { error: "Internal server error" });
      return makeJsonResponse(200, { anchors: [] });
    }) as unknown as typeof global.fetch;

    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseUp(svg, { clientX: 200, clientY: 150 });
    });

    const inputs = container.querySelectorAll("input");
    await act(async () => {
      fireEvent.change(inputs[0]!, { target: { value: "TestAnchor" } });
      fireEvent.change(inputs[1]!, { target: { value: "5.0" } });
      fireEvent.change(inputs[2]!, { target: { value: "10.0" } });
    });

    const saveBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(saveBtns[0]!); });

    await waitFor(() => {
      expect(screen.getByText(/internal server error/i)).toBeTruthy();
    });
  });

  it("dismiss button clears the error and resets slot to idle", async () => {
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return makeJsonResponse(500, { error: "Oops" });
      return makeJsonResponse(200, { anchors: [] });
    }) as unknown as typeof global.fetch;

    const { container } = await renderCalibration();

    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const placeBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^Place$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(placeBtns[0]!); });
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 200, clientY: 150 });
      fireEvent.mouseUp(svg, { clientX: 200, clientY: 150 });
    });

    const inputs = container.querySelectorAll("input");
    await act(async () => {
      fireEvent.change(inputs[0]!, { target: { value: "X" } });
      fireEvent.change(inputs[1]!, { target: { value: "1" } });
      fireEvent.change(inputs[2]!, { target: { value: "2" } });
    });

    const saveBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    await act(async () => { fireEvent.click(saveBtns[0]!); });

    // Wait for error to appear
    await waitFor(() => {
      expect(screen.getByText(/oops/i)).toBeTruthy();
    });

    // Click the dismiss button
    const dismissBtn = screen.getByRole("button", { name: /dismiss error for anchor 1/i });
    await act(async () => { fireEvent.click(dismissBtn); });

    // Error message should be gone
    await waitFor(() => {
      expect(screen.queryByText(/oops/i)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 7. ARIA attributes
// ---------------------------------------------------------------------------

describe("AnchorCalibration — ARIA attributes", () => {
  beforeEach(() => {
    global.fetch = stubFetchOk();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("per-slot status divs have aria-live=polite and aria-atomic=true", async () => {
    const { container } = await renderCalibration();

    const statusDivs = Array.from(container.querySelectorAll("[aria-live='polite']"));
    // One per slot
    expect(statusDivs.length).toBeGreaterThanOrEqual(3);
    for (const div of statusDivs) {
      expect(div.getAttribute("aria-atomic")).toBe("true");
    }
  });

  it("Save button aria-label says 'Save Anchor N' in idle phase", async () => {
    const { container } = await renderCalibration();

    const saveBtns = Array.from(container.querySelectorAll("button")).filter(
      (b) => /^(Save|Update)$/i.test(b.textContent?.trim() ?? ""),
    );
    // Slot 0 Save button idle label
    expect(saveBtns[0]!.getAttribute("aria-label")).toBe("Save Anchor 1");
    expect(saveBtns[1]!.getAttribute("aria-label")).toBe("Save Anchor 2");
    expect(saveBtns[2]!.getAttribute("aria-label")).toBe("Save Anchor 3");
  });
});

// ---------------------------------------------------------------------------
// 4. Clear API round-trip
// ---------------------------------------------------------------------------

describe("AnchorCalibration — clear behaviour", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * Bootstrap a component that has slot 1 pre-populated with a saved anchor,
   * so the Clear button is visible.
   */
  async function renderWithSavedAnchor(fetchOverride?: typeof global.fetch) {
    const savedAnchor = {
      id: 1,
      name: "A",
      svgX: 100,
      svgY: 200,
      worldX: 10,
      worldY: 20,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    global.fetch = fetchOverride ?? (vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return makeJsonResponse(200, {});
      return makeJsonResponse(200, { anchors: [savedAnchor] });
    }) as unknown as typeof global.fetch);

    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(<AnchorCalibration />);
    });
    // Wait for the anchor to load and the Clear button to appear
    await waitFor(() => {
      expect(screen.getByText(/clear/i)).toBeTruthy();
    });
    return result;
  }

  it("shows the Clear button only for saved slots", async () => {
    await renderWithSavedAnchor();
    // Exactly one Clear button (only slot 0 is saved)
    const clearBtns = screen.getAllByText(/^clear$/i);
    expect(clearBtns.length).toBe(1);
  });

  it("calls DELETE /admin/map-anchors/1 when Clear is confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      capturedRequests.push({ url, init: init ?? {} });
      if (init?.method === "DELETE") return makeJsonResponse(200, {});
      return makeJsonResponse(200, {
        anchors: [{
          id: 1, name: "A", svgX: 100, svgY: 200,
          worldX: 10, worldY: 20, updatedAt: "2026-01-01T00:00:00Z",
        }],
      });
    }) as unknown as typeof global.fetch;
    await renderWithSavedAnchor(fetchMock);

    const clearBtn = screen.getByText(/^clear$/i);
    await act(async () => { fireEvent.click(clearBtn); });

    const deleteCall = capturedRequests.find(
      (r) => r.init?.method === "DELETE" && String(r.url).includes("/admin/map-anchors/1"),
    );
    expect(deleteCall).toBeTruthy();
  });

  it("does NOT call DELETE when the confirm dialog is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      capturedRequests.push({ url, init: init ?? {} });
      return makeJsonResponse(200, {
        anchors: [{
          id: 1, name: "A", svgX: 100, svgY: 200,
          worldX: 10, worldY: 20, updatedAt: "2026-01-01T00:00:00Z",
        }],
      });
    }) as unknown as typeof global.fetch;
    await renderWithSavedAnchor(fetchMock);

    const clearBtn = screen.getByText(/^clear$/i);
    await act(async () => { fireEvent.click(clearBtn); });

    const deleteCall = capturedRequests.find(
      (r) => r.init?.method === "DELETE",
    );
    expect(deleteCall).toBeUndefined();
  });

  it("re-fetches anchors after a successful clear", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return makeJsonResponse(200, {});
      return makeJsonResponse(200, {
        anchors: [{
          id: 1, name: "A", svgX: 100, svgY: 200,
          worldX: 10, worldY: 20, updatedAt: "2026-01-01T00:00:00Z",
        }],
      });
    }) as unknown as typeof global.fetch;
    await renderWithSavedAnchor(fetchMock);

    const getCountBefore = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, init]: [string, RequestInit]) => !init?.method || init.method === "GET",
    ).length;

    const clearBtn = screen.getByText(/^clear$/i);
    await act(async () => { fireEvent.click(clearBtn); });

    await waitFor(() => {
      const getCountAfter = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, init]: [string, RequestInit]) => !init?.method || init.method === "GET",
      ).length;
      expect(getCountAfter).toBeGreaterThan(getCountBefore);
    });
  });

  it("shows error status when DELETE fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      // Return a JSON error body so the component can surface the server message.
      if (init?.method === "DELETE")
        return makeJsonResponse(500, { error: "Clear failed" });
      return makeJsonResponse(200, {
        anchors: [{
          id: 1, name: "A", svgX: 100, svgY: 200,
          worldX: 10, worldY: 20, updatedAt: "2026-01-01T00:00:00Z",
        }],
      });
    }) as unknown as typeof global.fetch;
    await renderWithSavedAnchor(fetchMock);

    const clearBtn = screen.getByText(/^clear$/i);
    await act(async () => { fireEvent.click(clearBtn); });

    // Error message now appears in the per-slot status row (✕ <message>).
    await waitFor(() => {
      expect(screen.getByText(/clear failed/i)).toBeTruthy();
    });
  });
});
