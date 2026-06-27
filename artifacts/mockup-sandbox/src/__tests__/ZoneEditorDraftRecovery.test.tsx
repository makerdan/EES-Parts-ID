/**
 * ZoneEditorDraftRecovery.test.tsx
 *
 * Integration tests for the ZoneEditor crash-recovery draft feature.
 *
 * Coverage:
 *   - A failed PATCH writes the unsaved form to localStorage under the correct key
 *   - On remount with a localStorage draft, the restore banner appears when the
 *     draft differs from the server-side zone state
 *   - Clicking "Restore" applies the draft form values and removes the draft
 *   - Clicking "Discard" removes the draft without changing the form
 */

import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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

// localStorage key mirroring DRAFT_LS_PREFIX + id from the component.
const DRAFT_KEY_1 = "zoneEditorDraft:1";

// ─── Click coordinates for ZONE_1 ──────────────────────────────────────────────
// INITIAL_SCALE = 0.18, tf = {x:0,y:0,s:0.18}, getBCR left=top=0
//   screenPt(cx,cy) = { x: cx/0.18, y: cy/0.18 }
//   ZONE_1 screen center = ((100+100)*0.18, (100+75)*0.18) = (36, 31.5)
const CLICK_ZONE_1 = { clientX: 36, clientY: 31 };

// ─── Fetch mock helpers ────────────────────────────────────────────────────────

type FetchArgs = [string, RequestInit | undefined];

function baseRoutes(zones: typeof ZONE_1[], url: string, method: string) {
  if (method === "GET" && url.includes("/floor-plan/svg"))
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });

  if (method === "GET" && url.includes("/warehouse-zones/coverage"))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }), text: () => Promise.resolve("") });

  if (method === "GET" && url.includes("/warehouse-zones"))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ zones }), text: () => Promise.resolve("") });

  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
}

function makeFailPatchFetchMock(zones = [ZONE_1]) {
  return vi.fn((...[url, init]: FetchArgs) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PATCH") return Promise.reject(new Error("Network error"));
    return baseRoutes(zones, String(url), method);
  });
}

function makeSuccessFetchMock(zones = [ZONE_1]) {
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

function getAisleInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[placeholder="e.g. 09 or 22"]') as HTMLInputElement;
}

// ─── Setup helpers ────────────────────────────────────────────────────────────

async function setupEditor(fetchMock: ReturnType<typeof vi.fn>) {
  global.fetch = fetchMock as unknown as typeof global.fetch;

  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ZoneEditor />));
  });

  // Wait for zones to load (fill rects appear once GET /warehouse-zones resolves).
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

/** Click ZONE_1's fill rect without moving — selects it, no PATCH. */
async function selectZone1(container: HTMLElement) {
  const zoneRect = getZoneFillRects(container)[0]!;
  await act(async () => {
    fireEvent.mouseDown(zoneRect, { ...CLICK_ZONE_1, button: 0 });
  });
  await act(async () => {
    document.dispatchEvent(
      new MouseEvent("mouseup", { ...CLICK_ZONE_1, bubbles: true }),
    );
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => { await Promise.resolve(); });
  }
  await act(async () => {});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ZoneEditor — draft recovery", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  // ── 1. Failed PATCH writes draft ──────────────────────────────────────────────
  it("failed PATCH (network error) writes the unsaved form to localStorage under the correct key", async () => {
    const fetchMock = makeFailPatchFetchMock();
    const { container } = await setupEditor(fetchMock);

    await selectZone1(container);

    // Verify the zone is selected and the form is populated.
    const aisleInput = getAisleInput(container);
    expect(aisleInput).not.toBeNull();
    expect(aisleInput.value).toBe("12");

    // Edit the Aisle ID to a value different from the server state.
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "99" } });
    });

    // Fire focusOut — bubbles as a React onBlur to the form container div,
    // which calls flushSave(committedForm, zoneId). PATCH will fail → writeDraft.
    await act(async () => {
      fireEvent.focusOut(aisleInput);
    });

    // Wait for the async flushSave catch block to write the draft.
    await waitFor(
      () => expect(localStorage.getItem(DRAFT_KEY_1)).not.toBeNull(),
      { timeout: 3000 },
    );

    const stored = localStorage.getItem(DRAFT_KEY_1)!;
    const draft = JSON.parse(stored) as {
      form: { aisleId: string; sectionNum: number | null; isInventory: boolean; sortOrder: number };
      savedAt: number;
    };

    // The stored form must reflect the edited value, not the original server state.
    expect(draft.form.aisleId).toBe("99");
    // All other fields must be unchanged from the zone's server state.
    expect(draft.form.sectionNum).toBe(ZONE_1.sectionNum);
    expect(draft.form.isInventory).toBe(ZONE_1.isInventory);
    expect(draft.form.sortOrder).toBe(ZONE_1.sortOrder);
    // savedAt must be a valid recent timestamp.
    expect(draft.savedAt).toBeGreaterThan(0);
    expect(draft.savedAt).toBeLessThanOrEqual(Date.now());
  });

  // ── 2. Draft on remount → restore banner appears ──────────────────────────────
  it("restore banner appears when a localStorage draft differs from the server-side zone state", async () => {
    // Seed localStorage with a draft whose aisleId differs from the server ("12").
    const draftForm = {
      aisleId: "99",
      sectionNum: ZONE_1.sectionNum,
      isInventory: ZONE_1.isInventory,
      sortOrder: ZONE_1.sortOrder,
    };
    localStorage.setItem(
      DRAFT_KEY_1,
      JSON.stringify({ form: draftForm, savedAt: Date.now() - 60_000 }),
    );

    const fetchMock = makeSuccessFetchMock();
    const { container } = await setupEditor(fetchMock);

    // Select ZONE_1 — the selection effect reads the draft and sets draftOffer.
    await selectZone1(container);

    // The restore banner must be visible.
    await waitFor(
      () => expect(container.textContent).toMatch(/Unsaved edits from/),
      { timeout: 3000 },
    );

    // Both action buttons must be present.
    const buttonLabels = [...container.querySelectorAll("button")].map(
      (b) => b.textContent?.trim(),
    );
    expect(buttonLabels).toContain("Restore");
    expect(buttonLabels).toContain("Discard");
  });

  // ── 3a. Restore applies the draft form and removes the draft ──────────────────
  it("clicking Restore loads the draft form values and removes the draft from localStorage", async () => {
    const draftForm = {
      aisleId: "99",
      sectionNum: ZONE_1.sectionNum,
      isInventory: ZONE_1.isInventory,
      sortOrder: ZONE_1.sortOrder,
    };
    localStorage.setItem(
      DRAFT_KEY_1,
      JSON.stringify({ form: draftForm, savedAt: Date.now() - 60_000 }),
    );

    const fetchMock = makeSuccessFetchMock();
    const { container } = await setupEditor(fetchMock);

    await selectZone1(container);

    // Wait for the restore banner to appear.
    await waitFor(
      () => expect(container.textContent).toMatch(/Unsaved edits from/),
      { timeout: 3000 },
    );

    // Click Restore.
    const restoreBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Restore",
    )!;
    expect(restoreBtn).not.toBeUndefined();
    await act(async () => { fireEvent.click(restoreBtn); });

    // The draft must be removed from localStorage.
    expect(localStorage.getItem(DRAFT_KEY_1)).toBeNull();

    // The restore banner must be gone.
    expect(container.textContent).not.toMatch(/Unsaved edits from/);

    // The Aisle ID input must now show the restored draft value, not the server value.
    const aisleInput = getAisleInput(container);
    expect(aisleInput.value).toBe("99");
  });

  // ── 3b. Discard removes draft without changing the form ───────────────────────
  it("clicking Discard removes the draft from localStorage without applying it to the form", async () => {
    const draftForm = {
      aisleId: "99",
      sectionNum: ZONE_1.sectionNum,
      isInventory: ZONE_1.isInventory,
      sortOrder: ZONE_1.sortOrder,
    };
    localStorage.setItem(
      DRAFT_KEY_1,
      JSON.stringify({ form: draftForm, savedAt: Date.now() - 60_000 }),
    );

    const fetchMock = makeSuccessFetchMock();
    const { container } = await setupEditor(fetchMock);

    await selectZone1(container);

    // Wait for the restore banner to appear.
    await waitFor(
      () => expect(container.textContent).toMatch(/Unsaved edits from/),
      { timeout: 3000 },
    );

    // Click Discard.
    const discardBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Discard",
    )!;
    expect(discardBtn).not.toBeUndefined();
    await act(async () => { fireEvent.click(discardBtn); });

    // The draft must be removed from localStorage.
    expect(localStorage.getItem(DRAFT_KEY_1)).toBeNull();

    // The restore banner must be gone.
    expect(container.textContent).not.toMatch(/Unsaved edits from/);

    // The form must still show the server state ("12"), not the discarded draft ("99").
    const aisleInput = getAisleInput(container);
    expect(aisleInput.value).toBe("12");
  });
});
