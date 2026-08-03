/**
 * ZoneEditorCalibrate.test.tsx
 *
 * Integration tests for ZoneEditor's Calibrate mode.
 *
 * Coverage:
 *   1. Load on mount — GET /warehouse-zones/alignment result reflected in the
 *      live offset readout once calibrate mode is entered.
 *   2. Entering calibrate mode — toolbar shows nudge/scale/save/revert controls.
 *   3. Nudge small step (→) — x readout increments by 5 and button goes dirty.
 *   4. Nudge large step (⤓) — y readout increments by 50 and button goes dirty.
 *   5. Scale controls — + increments %, − decrements %.
 *   6. Save happy path — PUT fires with correct body, button returns to "Saved".
 *   7. Save failure — PUT 500 leaves button at "Save ●", component stays mounted.
 *   8. Revert — restores offset to mount-time values, button returns to "Saved".
 *   9. Reset to zero — offset becomes 0/0/100%, button shows "Save ●".
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

// A known non-identity alignment offset so we can distinguish loaded vs. default.
// translateX/Y are SVG viewBox units; scale is a multiplier.
const LOADED_ALIGN = { translateX: 10, translateY: -5, scale: 1.1 };

// ── Fetch mock factory ────────────────────────────────────────────────────────

/**
 * Returns a vi.fn() that fakes every network call ZoneEditor makes on mount:
 *   GET /floor-plan/svg        → 404 (use bundled fallback)
 *   GET /warehouse-zones/coverage → standard empty coverage
 *   GET /warehouse-zones/alignment → LOADED_ALIGN
 *   GET /warehouse-zones       → empty zone list
 *   PUT /warehouse-zones/alignment → 200 (echoed) or putStatus error
 */
function makeFetchMock({ putStatus = 200 }: { putStatus?: number } = {}) {
  return vi.fn((url: string, init?: RequestInit) => {
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

    if (method === "GET" && s.includes("/warehouse-zones/alignment"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(LOADED_ALIGN),
        text: () => Promise.resolve(""),
      });

    if (method === "GET" && s.includes("/warehouse-zones"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ zones: [] }),
        text: () => Promise.resolve(""),
      });

    if (method === "PUT" && s.includes("/warehouse-zones/alignment"))
      return Promise.resolve({
        ok: putStatus === 200,
        status: putStatus,
        json: () => Promise.resolve(putStatus === 200 ? LOADED_ALIGN : { error: `HTTP ${putStatus}` }),
        text: () => Promise.resolve(""),
      });

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
  });
}

// ── Render helper ─────────────────────────────────────────────────────────────

async function setupEditor({ putStatus = 200 }: { putStatus?: number } = {}) {
  const fetchMock = makeFetchMock({ putStatus });
  global.fetch = fetchMock as unknown as typeof global.fetch;

  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ZoneEditor />));
  });

  // Drain async effects: zones GET, alignment GET, coverage GET all fire on mount.
  for (let i = 0; i < 4; i++) {
    await act(async () => { await Promise.resolve(); });
  }
  await act(async () => {});

  return { container, fetchMock };
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/** Find a button by its exact trimmed textContent. Throws if not found. */
function getBtn(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`Button "${text}" not found in container`);
  return found;
}

/** All button label strings currently rendered. */
function buttonTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
}

// ── Interaction helpers ───────────────────────────────────────────────────────

/** Click the ✛ Calibrate toolbar button and drain React state. */
async function enterCalibrateMode(container: HTMLElement) {
  await act(async () => {
    fireEvent.click(getBtn(container, "✛ Calibrate"));
  });
  await act(async () => { await Promise.resolve(); });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("ZoneEditor — Calibrate mode", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── 1. Load on mount ─────────────────────────────────────────────────────────

  it("load on mount — GET /alignment result shows in offset readout after entering calibrate", async () => {
    const { container, fetchMock } = await setupEditor();

    // Confirm the alignment GET was called during mount
    const alignGets = (fetchMock.mock.calls as [string][]).filter(
      ([url]) => String(url).includes("/warehouse-zones/alignment") && !String(url).endsWith("PUT"),
    );
    expect(alignGets.length).toBeGreaterThanOrEqual(1);

    await enterCalibrateMode(container);

    // After entering calibrate mode the readout must reflect the loaded values.
    await waitFor(() => {
      expect(container.textContent).toContain("x 10.0");
      expect(container.textContent).toContain("y -5.0");
      expect(container.textContent).toContain("110%");   // 1.1 * 100
    });
  });

  // ── 2. Entering calibrate mode ───────────────────────────────────────────────

  it("entering calibrate mode reveals nudge/scale/save/revert controls", async () => {
    const { container } = await setupEditor();

    // Controls not present before entering calibrate mode
    expect(container.textContent).not.toContain("Reset to zero");

    await enterCalibrateMode(container);

    // Nudge buttons present
    expect(buttonTexts(container)).toContain("→");
    expect(buttonTexts(container)).toContain("↓");
    // Scale buttons present
    expect(buttonTexts(container)).toContain("+");
    expect(buttonTexts(container)).toContain("−");
    // Action buttons present
    expect(buttonTexts(container)).toContain("Revert");
    expect(buttonTexts(container)).toContain("Reset to zero");
    // Save button is clean (align == savedAlign after load)
    await waitFor(() => {
      expect(buttonTexts(container)).toContain("Saved");
    });
  });

  // ── 3. Nudge small step ──────────────────────────────────────────────────────

  it("nudge right (→) increments x by 5 and transitions Save button to dirty", async () => {
    const { container } = await setupEditor();
    await enterCalibrateMode(container);

    // Wait for loaded values to settle
    await waitFor(() => expect(container.textContent).toContain("x 10.0"));

    await act(async () => {
      fireEvent.click(getBtn(container, "→"));
    });

    // x: 10 + 5 = 15
    expect(container.textContent).toContain("x 15.0");
    expect(buttonTexts(container)).toContain("Save ●");
    expect(buttonTexts(container)).not.toContain("Saved");
  });

  // ── 4. Nudge large step ──────────────────────────────────────────────────────

  it("nudge large down (⤓) increments y by 50 and marks state dirty", async () => {
    const { container } = await setupEditor();
    await enterCalibrateMode(container);

    await waitFor(() => expect(container.textContent).toContain("y -5.0"));

    await act(async () => {
      fireEvent.click(getBtn(container, "⤓"));
    });

    // y: -5 + 50 = 45
    expect(container.textContent).toContain("y 45.0");
    expect(buttonTexts(container)).toContain("Save ●");
  });

  // ── 5. Scale controls ────────────────────────────────────────────────────────

  it("+ increments scale readout by 1% and − decrements it", async () => {
    const { container } = await setupEditor();
    await enterCalibrateMode(container);

    // Loaded scale 1.1 → 110%
    await waitFor(() => expect(container.textContent).toContain("110%"));

    // Click + (ALIGN_SCALE_SMALL = 0.01 → +1%)
    await act(async () => {
      fireEvent.click(getBtn(container, "+"));
    });
    expect(container.textContent).toContain("111%");

    // Click − (ALIGN_SCALE_SMALL = 0.01 → -1%)
    await act(async () => {
      fireEvent.click(getBtn(container, "−"));
    });
    expect(container.textContent).toContain("110%");
  });

  // ── 6. Save happy path ───────────────────────────────────────────────────────

  it("save happy path — PUT fires with correct body and button returns to Saved", async () => {
    const { container, fetchMock } = await setupEditor({ putStatus: 200 });
    await enterCalibrateMode(container);

    await waitFor(() => expect(container.textContent).toContain("x 10.0"));

    // Nudge right to make dirty: x → 15
    await act(async () => {
      fireEvent.click(getBtn(container, "→"));
    });
    expect(buttonTexts(container)).toContain("Save ●");

    // Click Save ●
    await act(async () => {
      fireEvent.click(getBtn(container, "Save ●"));
    });

    // Wait for the async save to complete
    await waitFor(() => {
      expect(buttonTexts(container)).toContain("Saved");
      expect(buttonTexts(container)).not.toContain("Save ●");
    });

    // Verify PUT was called with the correct body
    const putCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(
      ([url, init]) =>
        String(url).includes("/warehouse-zones/alignment") &&
        (init?.method ?? "").toUpperCase() === "PUT",
    );
    expect(putCalls).toHaveLength(1);

    const body = JSON.parse(putCalls[0]![1].body as string) as {
      translateX: number;
      translateY: number;
      scale: number;
    };
    expect(body.translateX).toBe(15);       // 10 + 5
    expect(body.translateY).toBe(-5);       // unchanged
    expect(body.scale).toBeCloseTo(1.1, 5); // unchanged
  });

  // ── 7. Save failure ──────────────────────────────────────────────────────────

  it("save failure — PUT 500 leaves Save ● and component stays mounted with calibrate controls", async () => {
    const { container } = await setupEditor({ putStatus: 500 });
    await enterCalibrateMode(container);

    await waitFor(() => expect(container.textContent).toContain("x 10.0"));

    // Nudge to make dirty
    await act(async () => {
      fireEvent.click(getBtn(container, "→"));
    });

    // Click Save ●
    await act(async () => {
      fireEvent.click(getBtn(container, "Save ●"));
    });

    // After the failed PUT the component must not crash and remain dirty
    await waitFor(() => {
      expect(buttonTexts(container)).toContain("Save ●");
      expect(buttonTexts(container)).not.toContain("Saved");
    });

    // Calibrate controls still visible
    expect(buttonTexts(container)).toContain("Reset to zero");
  });

  // ── 8. Revert ────────────────────────────────────────────────────────────────

  it("revert — restores the offset to the mount-time values and shows Saved", async () => {
    const { container } = await setupEditor();
    await enterCalibrateMode(container);

    await waitFor(() => expect(container.textContent).toContain("x 10.0"));

    // Nudge to make dirty
    await act(async () => {
      fireEvent.click(getBtn(container, "→"));
    });
    expect(container.textContent).toContain("x 15.0");
    expect(buttonTexts(container)).toContain("Save ●");

    // Click Revert (enabled because dirty=true)
    await act(async () => {
      fireEvent.click(getBtn(container, "Revert"));
    });

    // Offset returns to loaded values, button becomes clean
    expect(container.textContent).toContain("x 10.0");
    expect(container.textContent).toContain("y -5.0");
    await waitFor(() => {
      expect(buttonTexts(container)).toContain("Saved");
      expect(buttonTexts(container)).not.toContain("Save ●");
    });
  });

  // ── 9. Reset to zero ─────────────────────────────────────────────────────────

  it("reset to zero — sets offset to 0/0/100% and marks dirty because loaded offset was non-identity", async () => {
    const { container } = await setupEditor();
    await enterCalibrateMode(container);

    await waitFor(() => expect(container.textContent).toContain("x 10.0"));

    // Click Reset to zero
    await act(async () => {
      fireEvent.click(getBtn(container, "Reset to zero"));
    });

    // Readout shows identity values
    expect(container.textContent).toContain("x 0.0");
    expect(container.textContent).toContain("y 0.0");
    expect(container.textContent).toContain("100%");

    // Loaded offset was non-identity → after reset the state is dirty
    expect(buttonTexts(container)).toContain("Save ●");
  });
});
