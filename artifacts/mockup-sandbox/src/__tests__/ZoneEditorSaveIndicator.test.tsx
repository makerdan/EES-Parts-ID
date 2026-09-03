/**
 * ZoneEditorSaveIndicator.test.tsx
 *
 * Tests for the global save-status indicator and Save button added to the
 * Zone Editor banner (second row, always visible — Calibrate mode was removed
 * in Task #850).
 *
 * Coverage:
 *   (a) Form change → status label shows "Unsaved changes ●" (dirty)
 *   (b) Successful auto-save flush → status label shows "All changes saved" (clean)
 *   (c) Failed PATCH → status label shows "Save failed — retry" (error),
 *       Save button re-enabled and labelled "Retry"
 *   (d) Second row is visible in Pan mode and remains visible in Draw mode
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ZoneEditor } from "../pages/ZoneEditor";

// ─── Fixture ──────────────────────────────────────────────────────────────────
const ZONE_1 = {
  id: 1,
  aisleId: "12",
  sectionNum: 1,
  isInventory: true,
  svgX: 100,
  svgY: 100,
  svgWidth: 200,
  svgHeight: 150,
  sortOrder: 0,
};

// ─── Fetch mock factory ────────────────────────────────────────────────────────
type FetchArgs = [string, RequestInit | undefined];

function makeFetchMock(patchOk = true, pendingPatch?: Promise<Response>) {
  return vi.fn((...[url, init]: FetchArgs) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const s = String(url);

    if (method === "GET" && s.includes("/floor-plan/svg"))
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });

    if (method === "GET" && s.includes("/warehouse-zones/coverage"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }),
        text: () => Promise.resolve(""),
      });

    if (s.includes("/warehouse-zones/alignment"))
      throw new Error(`unexpected alignment fetch: ${s}`);

    if (method === "GET" && s.includes("/warehouse-zones"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ zones: [ZONE_1] }),
        text: () => Promise.resolve(""),
      });

    if (method === "PATCH") {
      if (patchOk) {
        if (pendingPatch) return pendingPatch;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      } else {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "Server error" }), text: () => Promise.resolve("Server error") });
      }
    }

    if (s.includes("/warehouse-zones/alignment"))
      throw new Error(`unexpected alignment fetch: ${s}`);

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
  });
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function getSaveStatusRow(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-testid='save-status-row']");
}

function getSaveStatusLabel(container: HTMLElement): string {
  const row = getSaveStatusRow(container);
  if (!row) return "";
  const span = row.querySelector("span");
  return span?.textContent ?? "";
}

function getSaveButton(container: HTMLElement): HTMLButtonElement | null {
  const row = getSaveStatusRow(container);
  if (!row) return null;
  return row.querySelector("button");
}

function getZoneFillRects(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll("rect")].filter(
    (r) => r.getAttribute("fill")?.startsWith("rgba(0, 112, 255"),
  ) as SVGRectElement[];
}

function getAisleInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[placeholder="e.g. 09 or 22"]') as HTMLInputElement;
}

// ─── Render helper ─────────────────────────────────────────────────────────────
async function setupEditor(fetchMock: ReturnType<typeof makeFetchMock>) {
  global.fetch = fetchMock as unknown as typeof global.fetch;
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ZoneEditor />));
  });
  await waitFor(
    () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
    { timeout: 3000 },
  );
  const svgEl = container.querySelector("svg") as SVGSVGElement;
  vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 800, bottom: 600,
    width: 800, height: 600, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return { container, svgEl };
}

// Click a zone rect to select it.
// INITIAL_SCALE=0.18: ZONE_1 SVG center=(200,175), screen≈(36,31)
async function clickZone1(container: HTMLElement) {
  const [rect] = getZoneFillRects(container);
  await act(async () => {
    fireEvent.mouseDown(rect!, { clientX: 36, clientY: 31, button: 0 });
  });
  await act(async () => {
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 36, clientY: 31, bubbles: true }));
  });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => {});
}

// Switch to Draw mode via the mode button.
async function switchToDraw(container: HTMLElement) {
  const btn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.includes("Draw Zone"),
  );
  expect(btn).toBeDefined();
  await act(async () => { fireEvent.click(btn!); });
}

// Switch back to Pan mode.
async function switchToPan(container: HTMLElement) {
  const btn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Pan / Select",
  );
  expect(btn).toBeDefined();
  await act(async () => { fireEvent.click(btn!); });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe("ZoneEditor — save status indicator", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── (a) Form change → dirty ────────────────────────────────────────────────
  it("(a) shows 'Unsaved changes ●' after editing the aisle ID field", async () => {
    const fetchMock = makeFetchMock(true);
    const { container } = await setupEditor(fetchMock);

    // Select zone 1 so the form appears
    await clickZone1(container);

    const aisleInput = getAisleInput(container);
    expect(aisleInput).not.toBeNull();

    // Initially the form matches the last-saved state → clean
    expect(getSaveStatusLabel(container)).toBe("All changes saved");

    // Change the aisle ID → this triggers the auto-save effect → dirty
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "14" } });
    });
    // Allow state update to propagate
    await act(async () => { await Promise.resolve(); });

    expect(getSaveStatusLabel(container)).toBe("Unsaved changes ●");
  });

  // ── (b) Successful flush → clean ──────────────────────────────────────────
  it("(b) shows 'All changes saved' after a successful Save button click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = makeFetchMock(true);
    const { container } = await setupEditor(fetchMock);

    await clickZone1(container);

    const aisleInput = getAisleInput(container);

    // Dirty the form
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "14" } });
    });
    await act(async () => { await Promise.resolve(); });
    expect(getSaveStatusLabel(container)).toBe("Unsaved changes ●");

    // Click Save button — flushSave should fire and succeed
    const saveBtn = getSaveButton(container);
    expect(saveBtn).not.toBeNull();
    expect(saveBtn!.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(saveBtn!);
      // Advance timers and flush promises so the PATCH resolves
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    vi.useRealTimers();

    expect(getSaveStatusLabel(container)).toBe("All changes saved");
  });

  // ── (c) Failed PATCH → error, Retry button re-enabled ──────────────────────
  it("(c) shows 'Save failed — retry' and re-enables button as 'Retry' on PATCH failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = makeFetchMock(false);
    const { container } = await setupEditor(fetchMock);

    await clickZone1(container);

    const aisleInput = getAisleInput(container);

    // Dirty the form
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "14" } });
    });
    await act(async () => { await Promise.resolve(); });
    expect(getSaveStatusLabel(container)).toBe("Unsaved changes ●");

    // Click Save — the PATCH will fail (patchOk=false)
    const saveBtn = getSaveButton(container);
    await act(async () => {
      fireEvent.click(saveBtn!);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    vi.useRealTimers();

    // Should be in error state
    expect(getSaveStatusLabel(container)).toBe("Save failed — retry");
    const retryBtn = getSaveButton(container);
    expect(retryBtn).not.toBeNull();
    expect(retryBtn!.disabled).toBe(false);
    expect(retryBtn!.textContent).toBe("Retry");
  });

  // ── (d) Row present in Pan and Draw modes ─────────────────────────────────
  it("(d) save-status row is visible in Pan mode and remains visible after switching to Draw mode", async () => {
    const fetchMock = makeFetchMock(true);
    const { container } = await setupEditor(fetchMock);

    // Pan mode (default) — row should be present
    expect(getSaveStatusRow(container)).not.toBeNull();

    // Switch to Draw mode — row should still be present
    await switchToDraw(container);
    expect(getSaveStatusRow(container)).not.toBeNull();

    // Switch back to Pan — row must still be present
    await switchToPan(container);
    expect(getSaveStatusRow(container)).not.toBeNull();
  });

  // ── (e) Unmount cancels an in-flight debounced edit save ────────────────────
  it("(e) aborts an in-flight auto-save when the editor unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolvePatch!: (value: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = makeFetchMock(true, patchResponse);
    const { container } = await setupEditor(fetchMock);
    await clickZone1(container);
    await act(async () => {
      fireEvent.change(getAisleInput(container), { target: { value: "14" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    const patchCall = fetchMock.mock.calls.find(([, init]) => (init?.method ?? "GET").toUpperCase() === "PATCH");
    expect(patchCall).toBeDefined();
    const signal = patchCall?.[1]?.signal;
    expect(signal).toBeDefined();

    cleanup();
    expect(signal?.aborted).toBe(true);

    resolvePatch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as Response);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();
  });
});
