/**
 * ZoneEditorSelectionFlush.test.tsx
 *
 * Integration tests for ZoneEditor's selection-change flush behaviour.
 *
 * Coverage:
 *   - Editing zone A then clicking zone B flushes zone A's unsaved edits
 *     (single-select → different single-select path through the useEffect)
 *   - Editing zone A then pressing Escape (full deselect) flushes zone A's unsaved edits
 *     (single-select → null path through the useEffect)
 *   - Editing multi-select fields then leaving multi-select (Escape) flushes
 *     edits to all previously-selected zones via handleMultiAutoSave
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ZoneEditor } from "../pages/ZoneEditor";

// ─── Fixtures ──────────────────────────────────────────────────────────────────
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

const ZONE_2 = {
  id: 2,
  aisleId: "13",
  sectionNum: 1,
  isInventory: true,
  svgX: 400,
  svgY: 100,
  svgWidth: 200,
  svgHeight: 150,
  sortOrder: 1,
};

// ── Click screen coordinates ───────────────────────────────────────────────────
// INITIAL_SCALE = 0.18, transform = {x:0, y:0, s:0.18}, getBCR left=top=0
//   screenToSvg(cx, cy) = { x: cx / 0.18, y: cy / 0.18 }
// ZONE_1 SVG center = (100+100, 100+75) = (200, 175), screen ≈ (36, 31)
// ZONE_2 SVG center = (400+100, 100+75) = (500, 175), screen ≈ (90, 31)
const CLICK_ZONE_1 = { clientX: 36, clientY: 31 };
const CLICK_ZONE_2 = { clientX: 90, clientY: 31 };

// ─── Fetch mock helpers ────────────────────────────────────────────────────────
type FetchArgs = [string, RequestInit | undefined];

function baseRoutes(
  zones: typeof ZONE_1[],
  url: string,
  method: string,
) {
  if (method === "GET" && url.includes("/floor-plan/svg"))
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({}),
    });

  if (method === "GET" && url.includes("/warehouse-zones/coverage"))
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }),
      text: () => Promise.resolve(""),
    });

  if (method === "GET" && url.includes("/warehouse-zones"))
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ zones }),
      text: () => Promise.resolve(""),
    });

  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
  });
}

function makeFetchMock(zones = [ZONE_1, ZONE_2]) {
  return vi.fn((...[url, init]: FetchArgs) => {
    const method = (init?.method ?? "GET").toUpperCase();
    return baseRoutes(zones, String(url), method);
  });
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function getZoneFillRects(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll("rect")].filter(
    (r) => r.getAttribute("fill")?.startsWith("rgba(0, 112, 255"),
  ) as SVGRectElement[];
}

/** Single-select aisle input — placeholder "e.g. 09 or 22" */
function getAisleInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector(
    'input[placeholder="e.g. 09 or 22"]',
  ) as HTMLInputElement;
}

/**
 * Multi-select aisle input.
 * When all selected zones share the same aisleId the placeholder is "e.g. 09";
 * when they differ it is "— mixed —". We accept either so the helper works
 * regardless of whether the fixture zones share an aisle or not.
 * The single-select aisle input uses "e.g. 09 or 22" and is therefore excluded.
 */
function getMultiAisleInput(container: HTMLElement): HTMLInputElement | null {
  return (
    container.querySelector('input[placeholder="e.g. 09"]') ??
    container.querySelector('input[placeholder="— mixed —"]')
  ) as HTMLInputElement | null;
}

/** Returns all PATCH call bodies for the given zone id seen so far. */
function patchBodiesFor(
  fetchMock: ReturnType<typeof makeFetchMock>,
  zoneId: number,
): Record<string, unknown>[] {
  return (fetchMock.mock.calls as FetchArgs[])
    .filter(
      ([url, init]) =>
        String(url).includes(`/warehouse-zones/${zoneId}`) &&
        (init?.method ?? "").toUpperCase() === "PATCH",
    )
    .map(([, init]) => JSON.parse(init?.body as string));
}

/** Snapshot current call count; returned function yields new calls since snapshot. */
function callsAfter(fetchMock: ReturnType<typeof makeFetchMock>) {
  const offset = fetchMock.mock.calls.length;
  return () =>
    (fetchMock.mock.calls as FetchArgs[]).slice(offset);
}

// ─── Render helper ─────────────────────────────────────────────────────────────
async function setupEditor(fetchMock: ReturnType<typeof makeFetchMock>) {
  global.fetch = fetchMock as unknown as typeof global.fetch;

  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ZoneEditor />));
  });

  // Wait for zone fill rects to appear (GET /warehouse-zones resolved).
  await waitFor(
    () => expect(getZoneFillRects(container).length).toBeGreaterThan(0),
    { timeout: 3000 },
  );

  // Stub SVG getBoundingClientRect so screenToSvg is deterministic:
  //   svgPt(cx, cy) = { x: cx / 0.18, y: cy / 0.18 }
  const svgEl = container.querySelector("svg") as SVGSVGElement;
  vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 800, bottom: 600,
    width: 800, height: 600, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  return { container, svgEl };
}

/**
 * Simulate a zone-rect click (mouseDown on the rect, mouseUp on document).
 * No movement → ixRef stays in "move" mode but dragZoneRef never gets set,
 * so the onUp handler is a no-op and no PATCH fires from geometry drag.
 * Pass shiftKey=true for multi-select toggle (no mouseUp needed, but sent anyway).
 */
async function clickZoneRect(
  rect: SVGRectElement,
  coords: { clientX: number; clientY: number },
  shiftKey = false,
) {
  await act(async () => {
    fireEvent.mouseDown(rect, { ...coords, button: 0, shiftKey });
  });
  await act(async () => {
    document.dispatchEvent(
      new MouseEvent("mouseup", { ...coords, bubbles: true }),
    );
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => { await Promise.resolve(); });
  }
  await act(async () => {});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ZoneEditor — selection-change flush", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── 1. Switch to a different zone ──────────────────────────────────────────
  it("flushes unsaved single-select edits when the user clicks a different zone", async () => {
    const fetchMock = makeFetchMock();
    const { container } = await setupEditor(fetchMock);

    const [rect1, rect2] = getZoneFillRects(container);

    // Select ZONE_1 — this sets prevSelectedIdRef = 1 and lastSavedFormRef = {aisleId:"12",...}
    await clickZoneRect(rect1!, CLICK_ZONE_1);

    // Verify zone 1 is selected and the form shows its server state.
    const aisleInput = getAisleInput(container);
    expect(aisleInput).not.toBeNull();
    expect(aisleInput.value).toBe("12");

    // Edit the Aisle ID (does NOT trigger an immediate PATCH — relies on debounced auto-save).
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "99" } });
    });

    // Snapshot call count before the zone switch.
    const newCalls = callsAfter(fetchMock);

    // Click ZONE_2 — selectedId changes from 1 → 2, triggering the flush useEffect.
    // This must happen before the 600 ms auto-save timer fires, so no `waitFor` delay here.
    await clickZoneRect(rect2!, CLICK_ZONE_2);

    // Wait for the PATCH for zone 1 to appear.
    await waitFor(
      () => {
        const patches = newCalls().filter(
          ([url, init]) =>
            String(url).includes("/warehouse-zones/1") &&
            (init?.method ?? "").toUpperCase() === "PATCH",
        );
        expect(patches.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );

    // The PATCH body must contain the edited aisleId (normalised from "99").
    const patches = patchBodiesFor(fetchMock, 1).filter(
      (b) => "aisleId" in b,
    );
    expect(patches.length).toBeGreaterThan(0);
    // aisleId has been normalised (e.g. zero-padded) but must be based on "99".
    expect(String(patches[0]!.aisleId)).toMatch(/99/);

    // Zone 2's aisleId must NOT have been patched via this flush.
    const z2Patches = patchBodiesFor(fetchMock, 2).filter(
      (b) => "aisleId" in b,
    );
    expect(z2Patches.length).toBe(0);
  });

  // ── 2. Full deselect via Escape ────────────────────────────────────────────
  it("flushes unsaved single-select edits when the selection is cleared (Escape)", async () => {
    const fetchMock = makeFetchMock();
    const { container } = await setupEditor(fetchMock);

    const [rect1] = getZoneFillRects(container);

    // Select ZONE_1.
    await clickZoneRect(rect1!, CLICK_ZONE_1);

    const aisleInput = getAisleInput(container);
    expect(aisleInput.value).toBe("12");

    // Edit the Aisle ID.
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "77" } });
    });

    const newCalls = callsAfter(fetchMock);

    // Press Escape — the keyboard handler calls setSelectedIds(new Set()),
    // selectedId becomes null, and the flush useEffect fires for prevId = 1.
    // The handler guards against firing when an input is focused; in JSDOM
    // fireEvent.change does not move focus, so document.activeElement is
    // document.body and the Escape deselect fires normally.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {});

    // Wait for the PATCH for zone 1 to appear.
    await waitFor(
      () => {
        const patches = newCalls().filter(
          ([url, init]) =>
            String(url).includes("/warehouse-zones/1") &&
            (init?.method ?? "").toUpperCase() === "PATCH",
        );
        expect(patches.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );

    const patches = patchBodiesFor(fetchMock, 1).filter(
      (b) => "aisleId" in b,
    );
    expect(patches.length).toBeGreaterThan(0);
    expect(String(patches[0]!.aisleId)).toMatch(/77/);
  });

  // ── 3. Multi-select flush — leaving multi-select triggers handleMultiAutoSave ─
  it("flushes unsaved multi-select aisle edits when leaving multi-select", async () => {
    const fetchMock = makeFetchMock();
    const { container } = await setupEditor(fetchMock);

    const [rect1, rect2] = getZoneFillRects(container);

    // Select ZONE_1 (single-select first).
    await clickZoneRect(rect1!, CLICK_ZONE_1);

    // Shift+click ZONE_2 to toggle it into the multi-selection.
    // onZoneMouseDown handles shiftKey, updates selectedIds to {1,2}, and returns
    // early (no drag state set), so the multi-select flush useEffect sees prevIds={1,2}.
    await act(async () => {
      fireEvent.mouseDown(rect2!, { ...CLICK_ZONE_2, button: 0, shiftKey: true });
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {});

    // Verify the multi-select aisle input has appeared.
    await waitFor(
      () => expect(getMultiAisleInput(container)).not.toBeNull(),
      { timeout: 3000 },
    );

    const multiAisleInput = getMultiAisleInput(container)!;

    // Edit the shared aisle field — both zones have different aisleIds ("12", "13"),
    // so lastMultiAisleIdRef is "" (mixed). Changing to "55" marks an unsaved edit.
    await act(async () => {
      fireEvent.change(multiAisleInput, { target: { value: "55" } });
    });

    const newCalls = callsAfter(fetchMock);

    // Press Escape to clear the selection.
    // selectedIds becomes {}, isMulti becomes false.
    // The flush useEffect fires: prevIds = {1, 2} → handleMultiAutoSave({1, 2}).
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {});

    // Wait for PATCH calls for both zones to appear.
    await waitFor(
      () => {
        const patches = newCalls().filter(
          ([, init]) => (init?.method ?? "").toUpperCase() === "PATCH",
        );
        // handleMultiAutoSave fires one PATCH per zone in Promise.all.
        expect(patches.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 },
    );

    // Both zone 1 and zone 2 must have been patched with the new aisleId.
    const z1Patches = patchBodiesFor(fetchMock, 1).filter(
      (b) => "aisleId" in b,
    );
    const z2Patches = patchBodiesFor(fetchMock, 2).filter(
      (b) => "aisleId" in b,
    );

    expect(z1Patches.length).toBeGreaterThan(0);
    expect(z2Patches.length).toBeGreaterThan(0);

    // Both must have been patched with the edited value ("55" normalised).
    expect(String(z1Patches[0]!.aisleId)).toMatch(/55/);
    expect(String(z2Patches[0]!.aisleId)).toMatch(/55/);
  });
});
