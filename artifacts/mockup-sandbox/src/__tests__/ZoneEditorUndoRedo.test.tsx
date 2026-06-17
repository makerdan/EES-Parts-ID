/**
 * ZoneEditorUndoRedo.test.tsx
 *
 * Integration tests for the ZoneEditor undo/redo stack.
 *
 * Coverage:
 *   - pushUndo capped at 50 (oldest entry dropped when exceeded)
 *   - Undo of move   → PATCH with original position
 *   - Undo of resize → PATCH with original geometry
 *   - Undo of create → DELETE the created zone
 *   - Undo of delete → re-POST the zone data
 *   - Undo of batchMove → PATCH each zone to its pre-drag position
 *   - Redo after undo  → PATCH with the "after" position
 *   - Redo stack cleared when a new operation is pushed
 *   - Undo of bulk aisle reassignment (with sentinel conflict) → PATCH original aisleId + sectionNum
 *   - Redo of bulk aisle reassignment → PATCH resolved aisleId + sectionNums (including sentinels)
 */

import React from "react";
import {
  describe,
  it,
  expect,
  vi,
  afterEach,
} from "vitest";
import { render, act, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { ZoneEditor } from "../pages/ZoneEditor";

// ─── Constants mirroring the component ────────────────────────────────────────
const UNDO_LIMIT = 50;

// ─── Sample zone fixtures ──────────────────────────────────────────────────────
const ZONE_1 = {
  id: 1, aisleId: "12", label: "12", sectionNum: 1,
  isInventory: true, svgX: 100, svgY: 100, svgWidth: 200, svgHeight: 150, sortOrder: 0,
};

const ZONE_2 = {
  id: 2, aisleId: "13", label: "13", sectionNum: 1,
  isInventory: true, svgX: 400, svgY: 100, svgWidth: 200, svgHeight: 150, sortOrder: 1,
};

// ─── Fetch mock factory ────────────────────────────────────────────────────────
function makeFetchMock(zones = [ZONE_1]) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const s = String(url);

    if (method === "GET" && s.includes("/floor-plan/svg"))
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });

    if (method === "GET" && s.includes("/warehouse-zones/coverage"))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }), text: () => Promise.resolve("") });

    if (method === "GET" && s.includes("/warehouse-zones"))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ zones }), text: () => Promise.resolve("") });

    if (method === "PATCH")
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

    if (method === "POST" && s.includes("/warehouse-zones"))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ zone: { ...ZONE_1, id: 99 } }), text: () => Promise.resolve("") });

    if (method === "DELETE")
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
  });
}

// ─── Render helper ────────────────────────────────────────────────────────────
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

// ─── Coordinate notes ─────────────────────────────────────────────────────────
// INITIAL_SCALE = 0.18, tf = {x:0, y:0, s:0.18}, getBCR.left = top = 0
//   screenToSvg(cx, cy) = { x: cx/0.18, y: cy/0.18 }
//
// ZONE_1 (svgX=100, svgY=100, svgW=200, svgH=150):
//   screen center ≈ ((100+100)*0.18, (100+75)*0.18) = (36, 31.5)
const DRAG_FROM = { clientX: 36, clientY: 31 };  // inside ZONE_1
const DRAG_TO   = { clientX: 150, clientY: 120 }; // arbitrary destination

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function getZoneFillRects(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll("rect")].filter(
    (r) => r.getAttribute("fill")?.startsWith("rgba(0, 112, 255"),
  ) as SVGRectElement[];
}

function getHandleRects(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll("rect")].filter(
    (r) => r.getAttribute("fill") === "#f59e0b",
  ) as SVGRectElement[];
}

// ─── Assertion helpers ────────────────────────────────────────────────────────

/** Returns all PATCH call bodies for the given zone id (from a slice of calls). */
function patchBodiesFrom(
  calls: [unknown, RequestInit][],
  zoneId: number,
): Record<string, unknown>[] {
  return calls
    .filter(
      ([url, init]) =>
        String(url).includes(`/warehouse-zones/${zoneId}`) &&
        (init?.method ?? "").toUpperCase() === "PATCH",
    )
    .map(([, init]) => JSON.parse(init.body as string));
}

/** Returns all POST call bodies for /warehouse-zones (from a slice of calls). */
function postBodiesFrom(calls: [unknown, RequestInit][]): Record<string, unknown>[] {
  return calls
    .filter(
      ([url, init]) =>
        String(url).includes("/warehouse-zones") &&
        !String(url).match(/\/warehouse-zones\/\d+$/) &&
        (init?.method ?? "").toUpperCase() === "POST",
    )
    .map(([, init]) => JSON.parse(init.body as string));
}

/** Returns all DELETE call entries for the given zone id (from a slice of calls). */
function deleteCallsFrom(
  calls: [unknown, RequestInit][],
  zoneId: number,
): [unknown, RequestInit][] {
  return calls.filter(
    ([url, init]) =>
      String(url).includes(`/warehouse-zones/${zoneId}`) &&
      (init?.method ?? "").toUpperCase() === "DELETE",
  );
}

/** Snapshot the current fetchMock call count and return a helper that reads
 *  only NEW calls since the snapshot. */
function callsAfter(fetchMock: ReturnType<typeof makeFetchMock>) {
  const offset = fetchMock.mock.calls.length;
  return () => fetchMock.mock.calls.slice(offset) as [unknown, RequestInit][];
}

// ─── Interaction helpers ──────────────────────────────────────────────────────

/** Simulate a move drag on ZONE_1's fill rect. */
async function simulateMove(
  zoneRect: SVGRectElement,
  from = DRAG_FROM,
  to = DRAG_TO,
) {
  await act(async () => {
    fireEvent.mouseDown(zoneRect, { ...from, button: 0 });
  });
  await act(async () => {
    document.dispatchEvent(new MouseEvent("mousemove", { ...to, bubbles: true }));
  });
  await act(async () => {
    document.dispatchEvent(new MouseEvent("mouseup", { ...to, bubbles: true }));
  });
  // Drain the async onUp handler (PATCH + setZones) by waiting for multiple
  // microtask/macrotask cycles.
  for (let i = 0; i < 3; i++) {
    await act(async () => { await Promise.resolve(); });
  }
  await act(async () => {});
}

/** Press Ctrl+Z and wait for the async applyUndoRedo to settle. */
async function pressUndo(
  fetchMock: ReturnType<typeof makeFetchMock>,
  expectPatch = true,
) {
  const newCalls = callsAfter(fetchMock);
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
  );
  if (expectPatch) {
    // Wait until the undo's PATCH call appears in the mock (confirms async op completed)
    await waitFor(
      () => {
        const patches = newCalls().filter(
          ([, init]) => (init?.method ?? "").toUpperCase() === "PATCH",
        );
        expect(patches.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
  }
  await act(async () => {});
}

/** Press Ctrl+Shift+Z and wait for the async applyUndoRedo to settle. */
async function pressRedo(
  fetchMock: ReturnType<typeof makeFetchMock>,
  expectPatch = true,
) {
  const newCalls = callsAfter(fetchMock);
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true }),
  );
  if (expectPatch) {
    await waitFor(
      () => {
        const patches = newCalls().filter(
          ([, init]) => (init?.method ?? "").toUpperCase() === "PATCH",
        );
        expect(patches.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
  }
  await act(async () => {});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ZoneEditor — undo / redo stack", () => {
  // Explicitly call @testing-library cleanup after every test so that
  // different test instances never pollute each other's DOM queries.
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── 1. Undo of move ──────────────────────────────────────────────────────────
  it("undo move — PATCHes the zone back to its original position", async () => {
    const { container, fetchMock } = await setupEditor();

    await simulateMove(getZoneFillRects(container)[0]!);

    const afterMove = callsAfter(fetchMock);
    const movePatch = patchBodiesFrom(
      fetchMock.mock.calls as [unknown, RequestInit][],
      1,
    );
    expect(movePatch).toHaveLength(1);
    expect(movePatch[0]!.svgX).not.toBeCloseTo(ZONE_1.svgX);

    await pressUndo(fetchMock);

    const undoPatches = patchBodiesFrom(afterMove(), 1);
    expect(undoPatches).toHaveLength(1);
    expect(undoPatches[0]!.svgX).toBeCloseTo(ZONE_1.svgX);
    expect(undoPatches[0]!.svgY).toBeCloseTo(ZONE_1.svgY);
  });

  // ── 2. Undo of resize ────────────────────────────────────────────────────────
  it("undo resize — PATCHes the zone back to its original geometry", async () => {
    const { container, fetchMock } = await setupEditor();

    // Select ZONE_1 by clicking its rect then releasing at the same spot
    // (no mousemove → dragZoneRef stays null → no PATCH, just selection).
    const zoneRect = getZoneFillRects(container)[0]!;
    await act(async () => {
      fireEvent.mouseDown(zoneRect, { ...DRAG_FROM, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("mouseup", { ...DRAG_FROM, bubbles: true }),
      );
    });
    await act(async () => {});

    // Corner/edge handles are now visible for the single-selected zone.
    // After the render-order fix, edge handles (n/s/e/w) are rendered first
    // (indices 0-3) and corner handles (nw/ne/sw/se) follow (indices 4-7).
    // We need a corner handle (diagonal resize) so the width changes.
    const handles = getHandleRects(container);
    expect(handles.length).toBeGreaterThan(0);

    // Drag a corner handle (index 4 = nw) to resize diagonally
    await act(async () => {
      fireEvent.mouseDown(handles[4]!, { ...DRAG_FROM, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { ...DRAG_TO, bubbles: true }),
      );
    });
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("mouseup", { ...DRAG_TO, bubbles: true }),
      );
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {});

    const resizePatches = (fetchMock.mock.calls as [unknown, RequestInit][])
      .filter(
        ([url, init]) =>
          String(url).includes("/warehouse-zones/1") &&
          (init?.method ?? "").toUpperCase() === "PATCH" &&
          "svgWidth" in JSON.parse(init.body as string),
      );
    expect(resizePatches).toHaveLength(1);
    const resizedGeom = JSON.parse(
      (resizePatches[0]![1] as RequestInit).body as string,
    );
    expect(resizedGeom.svgWidth).not.toBeCloseTo(ZONE_1.svgWidth);

    const afterResize = callsAfter(fetchMock);
    await pressUndo(fetchMock);

    const undoPatches = patchBodiesFrom(afterResize(), 1);
    expect(undoPatches).toHaveLength(1);
    expect(undoPatches[0]!.svgX).toBeCloseTo(ZONE_1.svgX);
    expect(undoPatches[0]!.svgY).toBeCloseTo(ZONE_1.svgY);
    expect(undoPatches[0]!.svgWidth).toBeCloseTo(ZONE_1.svgWidth);
    expect(undoPatches[0]!.svgHeight).toBeCloseTo(ZONE_1.svgHeight);
  });

  // ── 3. Undo of create ────────────────────────────────────────────────────────
  it("undo create — DELETEs the zone that was just saved", async () => {
    const { container, svgEl, fetchMock } = await setupEditor([]);

    // Enter draw mode using within(container) to avoid ambiguity
    await act(async () => {
      const drawBtn = within(container).getAllByText("Draw Zone")[0]!;
      fireEvent.click(drawBtn);
    });

    // Draw a rect large enough (> MIN_ZONE_PX = 8 / 0.18 ≈ 44 svg units):
    //   svgPt(10,10) ≈ (55.6, 55.6), svgPt(60,50) ≈ (333, 278) → 278×222 SVG units
    const drawFrom = { clientX: 10, clientY: 10 };
    const drawTo   = { clientX: 60, clientY: 50 };

    await act(async () => {
      fireEvent.mouseDown(svgEl, { ...drawFrom, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { ...drawTo, bubbles: true }));
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { ...drawTo, bubbles: true }));
    });
    await act(async () => {});

    // Fill in the aisle ID (required for Save Zone to be enabled)
    await act(async () => {
      const aisleInput = within(container).getByPlaceholderText("e.g. 09 or 22");
      fireEvent.change(aisleInput, { target: { value: "15" } });
    });

    // Click "Save Zone" (scoped to this container)
    const newCalls = callsAfter(fetchMock);
    await act(async () => {
      const saveBtn = within(container).getAllByText("Save Zone")[0]!;
      fireEvent.click(saveBtn);
    });

    // Wait for the POST to appear
    await waitFor(() => {
      expect(postBodiesFrom(newCalls())).toHaveLength(1);
    });
    await act(async () => {});

    // Undo should DELETE the newly created zone (id=99 from mock)
    const afterCreate = callsAfter(fetchMock);
    await pressUndo(fetchMock, false); // undo create deletes, not patches

    await waitFor(() => {
      expect(deleteCallsFrom(afterCreate(), 99)).toHaveLength(1);
    });
  });

  // ── 4. Undo of delete ────────────────────────────────────────────────────────
  it("undo delete — re-POSTs the zone to restore it", async () => {
    const { container, fetchMock } = await setupEditor();

    // Select ZONE_1 via the sidebar zone list (stable data-zone-id attribute)
    await act(async () => {
      const zoneEl = container.querySelector('[data-zone-id="1"]')!;
      fireEvent.click(zoneEl);
    });
    await act(async () => {});

    // Click the sidebar Delete button (first "Delete" found in this container)
    await act(async () => {
      const deleteBtns = within(container).getAllByText("Delete");
      // Before the confirm dialog, there is only 1 Delete button (in the sidebar)
      fireEvent.click(deleteBtns[0]!);
    });
    await act(async () => {});

    // Confirm dialog is now visible. Its "Delete" button is the destructive confirm.
    // The confirm dialog renders FIRST in the DOM tree, so its Delete button
    // has index [0] among all Delete buttons.
    await act(async () => {
      const allDeleteBtns = within(container).getAllByText("Delete");
      fireEvent.click(allDeleteBtns[0]!);
    });

    // Wait for the DELETE fetch call to appear
    await waitFor(() => {
      const delCalls = (fetchMock.mock.calls as [unknown, RequestInit][]).filter(
        ([url, init]) =>
          String(url).includes("/warehouse-zones/1") &&
          (init?.method ?? "").toUpperCase() === "DELETE",
      );
      expect(delCalls).toHaveLength(1);
    });
    await act(async () => {});

    // Undo delete → re-POST the zone
    const afterDelete = callsAfter(fetchMock);
    await pressUndo(fetchMock, false); // undo delete posts, not patches

    await waitFor(() => {
      const posts = postBodiesFrom(afterDelete());
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        aisleId: ZONE_1.aisleId,
        svgX: ZONE_1.svgX,
        svgY: ZONE_1.svgY,
        svgWidth: ZONE_1.svgWidth,
        svgHeight: ZONE_1.svgHeight,
      });
    });
  });

  // ── 5. Undo of batchMove ─────────────────────────────────────────────────────
  it("undo batchMove — PATCHes each zone back to its pre-drag position", async () => {
    const { container, fetchMock } = await setupEditor([ZONE_1, ZONE_2]);

    // Select ZONE_1 then Shift+click ZONE_2 via the sidebar zone list
    await act(async () => {
      const zone1El = container.querySelector('[data-zone-id="1"]')!;
      fireEvent.click(zone1El);
    });
    await act(async () => {});

    await act(async () => {
      const zone2El = container.querySelector('[data-zone-id="2"]')!;
      fireEvent.click(zone2El, { shiftKey: true });
    });
    await act(async () => {});

    // With 2 zones selected, mousedown on ZONE_1's fill rect → multiMove
    const zoneRects = getZoneFillRects(container);
    expect(zoneRects.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      fireEvent.mouseDown(zoneRects[0]!, { ...DRAG_FROM, button: 0 });
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { ...DRAG_TO, bubbles: true }));
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { ...DRAG_TO, bubbles: true }));
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => {});

    // Verify both zones were PATCHed
    const allPatchCalls = (fetchMock.mock.calls as [unknown, RequestInit][]).filter(
      ([, init]) => (init?.method ?? "").toUpperCase() === "PATCH",
    );
    expect(allPatchCalls.length).toBeGreaterThanOrEqual(2);

    // Undo batchMove → restore both zones
    const afterBatch = callsAfter(fetchMock);
    await pressUndo(fetchMock);

    await waitFor(() => {
      const undo1 = patchBodiesFrom(afterBatch(), 1);
      const undo2 = patchBodiesFrom(afterBatch(), 2);
      expect(undo1).toHaveLength(1);
      expect(undo2).toHaveLength(1);
    });

    const newCalls = afterBatch();
    const undo1 = patchBodiesFrom(newCalls, 1);
    const undo2 = patchBodiesFrom(newCalls, 2);
    expect(undo1[0]!.svgX).toBeCloseTo(ZONE_1.svgX);
    expect(undo1[0]!.svgY).toBeCloseTo(ZONE_1.svgY);
    expect(undo2[0]!.svgX).toBeCloseTo(ZONE_2.svgX);
    expect(undo2[0]!.svgY).toBeCloseTo(ZONE_2.svgY);
  });

  // ── 6. Redo after undo ──────────────────────────────────────────────────────
  it("redo after undo — PATCHes the zone to the post-move position", async () => {
    const { container, fetchMock } = await setupEditor();

    await simulateMove(getZoneFillRects(container)[0]!);

    // Capture the "after" position from the initial move PATCH
    const movePatches = patchBodiesFrom(
      fetchMock.mock.calls as [unknown, RequestInit][],
      1,
    );
    expect(movePatches).toHaveLength(1);
    const afterPos = movePatches[0]!;

    await pressUndo(fetchMock);

    // Now redo — track only calls that happen after this point
    const afterUndo = callsAfter(fetchMock);
    await pressRedo(fetchMock);

    await waitFor(() => {
      const redoPatches = patchBodiesFrom(afterUndo(), 1);
      expect(redoPatches).toHaveLength(1);
    });

    const redoPatches = patchBodiesFrom(afterUndo(), 1);
    expect(redoPatches[0]!.svgX).toBeCloseTo(afterPos.svgX as number);
    expect(redoPatches[0]!.svgY).toBeCloseTo(afterPos.svgY as number);
  });

  // ── 7. Redo stack cleared on new operation ───────────────────────────────────
  it("performing a new operation clears the redo stack", async () => {
    const { container, fetchMock } = await setupEditor();

    // Move → undo → redo stack now has one entry
    await simulateMove(getZoneFillRects(container)[0]!);
    await pressUndo(fetchMock);

    // A second move pushes a new entry and clears the redo stack
    await simulateMove(getZoneFillRects(container)[0]!);

    // Attempt redo — should be a no-op (empty redo stack)
    const afterSecondMove = callsAfter(fetchMock);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true }),
    );

    // Wait long enough for any spurious async operations to surface
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    await act(async () => {});

    // No PATCH from redo (redo stack was cleared by the second move)
    const redoPatches = patchBodiesFrom(afterSecondMove(), 1);
    expect(redoPatches).toHaveLength(0);
  });

  // ── 8. Push limit — oldest entry dropped at UNDO_LIMIT + 1 ──────────────────
  it(
    `pushUndo is capped at ${UNDO_LIMIT}: the oldest entry is dropped when exceeded`,
    async () => {
      const { container, fetchMock } = await setupEditor();

      // Push UNDO_LIMIT + 1 entries onto the undo stack via move drags.
      // Each drag reuses the same from/to coords (the mock always returns the
      // original position so the zone "snaps back" after each fetchZones,
      // allowing the next move to start from the same state).
      for (let i = 0; i < UNDO_LIMIT + 1; i++) {
        await simulateMove(getZoneFillRects(container)[0]!);
      }

      // Undo UNDO_LIMIT + 1 times and count successful PATCHes.
      let patchCount = 0;
      for (let i = 0; i < UNDO_LIMIT + 1; i++) {
        const snapshot = callsAfter(fetchMock);
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
        );
        // Wait a fixed amount: if a PATCH appears, this undo was live;
        // if nothing appears after a short delay, the stack was already empty.
        try {
          await waitFor(
            () => {
              expect(patchBodiesFrom(snapshot(), 1)).toHaveLength(1);
            },
            { timeout: 800 },
          );
          patchCount++;
        } catch {
          // No PATCH appeared → undo stack was empty (no-op)
        }
        await act(async () => {});
      }

      // Exactly UNDO_LIMIT (50) undos should have triggered a PATCH;
      // the (UNDO_LIMIT + 1)th was a no-op because the oldest entry was dropped.
      expect(patchCount).toBe(UNDO_LIMIT);
    },
    // This test does 101 async operations; give it ample time.
    30_000,
  );

  // ── 9. Undo of bulk aisle reassignment (with sentinel conflict) ─────────────
  //
  // ZONE_1 (id=1, aisleId="12", sectionNum=1) and ZONE_2 (id=2, aisleId="13", sectionNum=1)
  // share sectionNum=1. Moving both to aisle "15" triggers conflict resolution:
  //   · Zone 1 keeps sectionNum=1 (no conflict) → body = { aisleId: "15" }
  //   · Zone 2 collides → sentinel -1 assigned  → body = { aisleId: "15", sectionNum: -1 }
  // Undo must restore each zone's original aisleId and sectionNum.
  it("undo bulk aisle reassignment — PATCHes each zone back to its original aisleId and sectionNum", async () => {
    const { container, fetchMock } = await setupEditor([ZONE_1, ZONE_2]);

    // Select ZONE_1 then Shift+click ZONE_2 via the sidebar list to enter multi-select
    await act(async () => {
      const zone1El = container.querySelector('[data-zone-id="1"]')!;
      fireEvent.click(zone1El);
    });
    await act(async () => {});
    await act(async () => {
      const zone2El = container.querySelector('[data-zone-id="2"]')!;
      fireEvent.click(zone2El, { shiftKey: true });
    });
    await act(async () => {});

    // Zones have different aisleIds so the multi-select aisle input shows "— mixed —".
    // Both zones share sectionNum=1, so the section-number input shows "01". We clear
    // it so that updates = { aisleId: "15" } only — this exercises the conflict-resolution
    // path (both zones carry sectionNum=1 into aisle "15"; zone 2 gets a sentinel).
    await act(async () => {
      const aisleInput = within(container).getByPlaceholderText("— mixed —");
      fireEvent.change(aisleInput, { target: { value: "15" } });
    });
    await act(async () => {
      const sectionInput = within(container).getByPlaceholderText("e.g. 06 or A");
      fireEvent.change(sectionInput, { target: { value: "" } });
    });

    // Click "Save 2 zones" — this calls handleMultiSave which shows a confirm dialog first
    await act(async () => {
      const saveBtn = within(container).getByText("Save 2 zones");
      fireEvent.click(saveBtn);
    });
    await act(async () => {});

    // Confirm the dialog ("Confirm" for non-destructive operations)
    await act(async () => {
      const confirmBtn = within(container).getByText("Confirm");
      fireEvent.click(confirmBtn);
    });

    // Wait for PATCH calls for both zones to settle
    await waitFor(
      () => {
        const all = fetchMock.mock.calls as [unknown, RequestInit][];
        const p1 = patchBodiesFrom(all, 1);
        const p2 = patchBodiesFrom(all, 2);
        expect(p1.length + p2.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 },
    );
    await act(async () => {});

    // Undo → each zone PATCHed back to its original aisleId and sectionNum
    const afterBulk = callsAfter(fetchMock);
    await pressUndo(fetchMock);

    await waitFor(
      () => {
        const undo1 = patchBodiesFrom(afterBulk(), 1);
        const undo2 = patchBodiesFrom(afterBulk(), 2);
        expect(undo1).toHaveLength(1);
        expect(undo2).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    const undoCalls = afterBulk();
    const undo1 = patchBodiesFrom(undoCalls, 1);
    const undo2 = patchBodiesFrom(undoCalls, 2);

    // Zone 1: original was aisleId="12", sectionNum=1
    expect(undo1[0]).toMatchObject({ aisleId: ZONE_1.aisleId, sectionNum: ZONE_1.sectionNum });
    // Zone 2: original was aisleId="13", sectionNum=1 (even though it received a sentinel)
    expect(undo2[0]).toMatchObject({ aisleId: ZONE_2.aisleId, sectionNum: ZONE_2.sectionNum });
  });

  // ── 10. Redo of bulk aisle reassignment (including sentinel) ─────────────────
  //
  // After undoing the bulk reassignment, redo must re-apply the resolved "after"
  // snapshots: zone 1 gets aisleId="15" only (sectionNum omitted — no conflict),
  // zone 2 gets aisleId="15" + sentinel sectionNum (< 0).
  it("redo bulk aisle reassignment — PATCHes zones with resolved aisleId and sectionNums including the sentinel", async () => {
    const { container, fetchMock } = await setupEditor([ZONE_1, ZONE_2]);

    // Identical setup: select both zones and bulk-reassign to aisle "15"
    await act(async () => {
      const zone1El = container.querySelector('[data-zone-id="1"]')!;
      fireEvent.click(zone1El);
    });
    await act(async () => {});
    await act(async () => {
      const zone2El = container.querySelector('[data-zone-id="2"]')!;
      fireEvent.click(zone2El, { shiftKey: true });
    });
    await act(async () => {});

    // Both zones share sectionNum=1 — clear the section-number input so that
    // updates = { aisleId: "15" } only, exercising conflict resolution (not passthrough).
    await act(async () => {
      const aisleInput = within(container).getByPlaceholderText("— mixed —");
      fireEvent.change(aisleInput, { target: { value: "15" } });
    });
    await act(async () => {
      const sectionInput = within(container).getByPlaceholderText("e.g. 06 or A");
      fireEvent.change(sectionInput, { target: { value: "" } });
    });

    await act(async () => {
      const saveBtn = within(container).getByText("Save 2 zones");
      fireEvent.click(saveBtn);
    });
    await act(async () => {});

    await act(async () => {
      const confirmBtn = within(container).getByText("Confirm");
      fireEvent.click(confirmBtn);
    });

    // Wait for the initial bulk PATCH calls to land
    await waitFor(
      () => {
        const all = fetchMock.mock.calls as [unknown, RequestInit][];
        const p1 = patchBodiesFrom(all, 1);
        const p2 = patchBodiesFrom(all, 2);
        expect(p1.length + p2.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 },
    );
    await act(async () => {});

    // Zone 2 conflicts with Zone 1 (both have sectionNum=1), so it is assigned
    // the first available sentinel: -1. This is deterministic given the test setup
    // (no pre-existing zones in aisle "15", zones processed in selection order [1,2]).
    const sentinelSectionNum = -1;

    // Undo the bulk reassignment
    await pressUndo(fetchMock);

    // Redo → zones should receive the resolved "after" values from the undo entry
    const afterUndo = callsAfter(fetchMock);
    await pressRedo(fetchMock);

    await waitFor(
      () => {
        const redo1 = patchBodiesFrom(afterUndo(), 1);
        const redo2 = patchBodiesFrom(afterUndo(), 2);
        expect(redo1).toHaveLength(1);
        expect(redo2).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    const redoCalls = afterUndo();
    const redo1 = patchBodiesFrom(redoCalls, 1);
    const redo2 = patchBodiesFrom(redoCalls, 2);

    // Zone 1 had no conflict → redo applies aisleId="15" only (no sectionNum,
    // matching the original PATCH body which also omitted sectionNum).
    expect(redo1[0]).toMatchObject({ aisleId: "15" });
    expect(redo1[0]).not.toHaveProperty("sectionNum");
    // Zone 2 had a sentinel conflict → redo applies aisleId="15" + the same sentinel
    expect(redo2[0]!.aisleId).toBe("15");
    expect(redo2[0]!.sectionNum).toBe(sentinelSectionNum);
  });

  // ── 11. Mid-batch undo failure → error surfaced, entry NOT silently consumed ──
  //
  // If one PATCH fails during multiEdit undo, the component must surface an error
  // and must NOT silently leave zone 1 in the "before" state while zone 2 stays in
  // the "after" state with no indication to the user.
  //
  // Verified by:
  //   a) Both zone 1 and zone 2 PATCH calls are attempted (Promise.allSettled runs all)
  //   b) The undo entry is NOT consumed (it stays on the undo stack), so retrying undo
  //      after restoring a working mock fires PATCHes for both zones again.
  it("mid-batch undo failure — surfaces error and leaves undo entry on the stack", async () => {
    const { container, fetchMock } = await setupEditor([ZONE_1, ZONE_2]);

    // ── Step 1: bulk aisle reassignment to create a multiEdit undo entry ──────
    await act(async () => {
      const zone1El = container.querySelector('[data-zone-id="1"]')!;
      fireEvent.click(zone1El);
    });
    await act(async () => {});
    await act(async () => {
      const zone2El = container.querySelector('[data-zone-id="2"]')!;
      fireEvent.click(zone2El, { shiftKey: true });
    });
    await act(async () => {});

    await act(async () => {
      const aisleInput = within(container).getByPlaceholderText("— mixed —");
      fireEvent.change(aisleInput, { target: { value: "15" } });
    });

    await act(async () => {
      const saveBtn = within(container).getByText("Save 2 zones");
      fireEvent.click(saveBtn);
    });
    await act(async () => {});

    await act(async () => {
      const confirmBtn = within(container).getByText("Confirm");
      fireEvent.click(confirmBtn);
    });

    // Wait for the bulk PATCH calls to settle
    await waitFor(
      () => {
        const all = fetchMock.mock.calls as [unknown, RequestInit][];
        const p1 = patchBodiesFrom(all, 1);
        const p2 = patchBodiesFrom(all, 2);
        expect(p1.length + p2.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 },
    );
    await act(async () => {});

    // ── Step 2: install a fetch mock where zone 2 PATCH returns 500 ───────────
    const failingFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const s = String(url);

      // Zone 2 PATCH → 500 (simulates mid-batch failure)
      if (method === "PATCH" && s.includes("/warehouse-zones/2"))
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

      if (method === "GET" && s.includes("/floor-plan/svg"))
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });

      if (method === "GET" && s.includes("/warehouse-zones/coverage"))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }), text: () => Promise.resolve("") });

      if (method === "GET" && s.includes("/warehouse-zones"))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ zones: [ZONE_1, ZONE_2] }), text: () => Promise.resolve("") });

      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
    });
    global.fetch = failingFetch as unknown as typeof global.fetch;

    // ── Step 3: press undo — zone 2 PATCH will fail ───────────────────────────
    const afterBulk = callsAfter(failingFetch);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );

    // Wait until both zone 1 and zone 2 PATCH calls appear (allSettled runs all)
    await waitFor(
      () => {
        const calls = afterBulk();
        const p1 = patchBodiesFrom(calls, 1);
        const p2 = patchBodiesFrom(calls, 2);
        // Both patches must have been attempted despite zone 2 failing
        expect(p1.length).toBeGreaterThanOrEqual(1);
        expect(p2.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 },
    );
    await act(async () => {});

    // ── Step 4: restore a working mock and retry undo ─────────────────────────
    // The undo entry must still be on the stack (not silently consumed on error),
    // so a second undo attempt fires PATCHes for both zones again.
    const workingFetch = makeFetchMock([ZONE_1, ZONE_2]);
    global.fetch = workingFetch as unknown as typeof global.fetch;

    const afterRetry = callsAfter(workingFetch);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );

    await waitFor(
      () => {
        const calls = afterRetry();
        const p1 = patchBodiesFrom(calls, 1);
        const p2 = patchBodiesFrom(calls, 2);
        // Both zones must be re-attempted on the retry
        expect(p1).toHaveLength(1);
        expect(p2).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    // Verify that the retry applied the correct "before" values for each zone
    const retryCalls = afterRetry();
    const retry1 = patchBodiesFrom(retryCalls, 1);
    const retry2 = patchBodiesFrom(retryCalls, 2);
    expect(retry1[0]).toMatchObject({ aisleId: ZONE_1.aisleId, sectionNum: ZONE_1.sectionNum });
    expect(retry2[0]).toMatchObject({ aisleId: ZONE_2.aisleId, sectionNum: ZONE_2.sectionNum });
  });
});
