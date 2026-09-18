import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ZoneEditor } from "../pages/ZoneEditor";
import {
  DEFAULT_GRID_SPACING,
  DEFAULT_STANDARD_RECT,
  clampDeltaForRects,
  moveRect,
  placeStandardRect,
  readBoundedNumber,
  resizeRect,
  snapCoordinate,
} from "../utils/svgCoords";

const ZONE = {
  id: 7,
  aisleId: "07",
  label: "07",
  sectionNum: 1,
  isInventory: true,
  svgX: 100,
  svgY: 100,
  svgWidth: 200,
  svgHeight: 150,
  sortOrder: 0,
};

function setupEditor() {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = String(url);
    if (method === "GET" && path.includes("/floor-plan/svg")) {
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });
    }
    if (method === "GET" && path.includes("/warehouse-zones/coverage")) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({ unsortedCount: 0, uncoveredAisles: [] }) });
    }
    if (method === "GET" && path.includes("/warehouse-zones")) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({ zones: [ZONE] }) });
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({}) });
  });
  global.fetch = fetchMock as unknown as typeof global.fetch;
  const result = render(<ZoneEditor />);
  return { ...result, fetchMock };
}

describe("Zone Editor grid geometry", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps existing raw-coordinate behavior when snapping is disabled", () => {
    expect(
      moveRect(
        { x: 100, y: 100, w: 200, h: 150 },
        { x: 113.25, y: 126.5 },
        { snap: false, spacing: DEFAULT_GRID_SPACING },
      ),
    ).toMatchObject({ x: 113.25, y: 126.5 });
  });

  it("rounds only coordinates within the small grid threshold", () => {
    expect(snapCoordinate(106, 10)).toBe(106);
    expect(snapCoordinate(109, 10)).toBe(110);
    expect(snapCoordinate(14, 10)).toBe(14);
  });

  it("snaps movement and clamps a zone to the floor-plan bounds", () => {
    expect(
      moveRect(
        { x: 100, y: 100, w: 200, h: 150 },
        { x: 803, y: 701 },
        { snap: true, spacing: 10, bounds: { w: 900, h: 800 } },
      ),
    ).toEqual({ x: 700, y: 650, w: 200, h: 150 });
  });

  it("applies one clamped delta to every selected zone", () => {
    const delta = clampDeltaForRects(
      [
        { x: 100, y: 100, w: 200, h: 150 },
        { x: 350, y: 120, w: 100, h: 80 },
      ],
      { x: 700, y: -200 },
      { w: 900, h: 800 },
    );
    expect(delta).toEqual({ x: 450, y: -100 });
  });

  it("preserves the opposite anchor during snapped edge and corner resizing", () => {
    expect(
      resizeRect(
        { x: 100, y: 100, w: 200, h: 150 },
        "nw",
        { x: 51, y: 49 },
        20,
        { snap: true, spacing: 10, bounds: { w: 900, h: 800 } },
      ),
    ).toEqual({ x: 50, y: 50, w: 250, h: 200 });

    expect(
      resizeRect(
        { x: 100, y: 100, w: 200, h: 150 },
        "se",
        { x: 307, y: 253 },
        20,
        { snap: true, spacing: 10, bounds: { w: 900, h: 800 } },
      ),
    ).toEqual({ x: 100, y: 100, w: 210, h: 150 });
  });

  it("places the standard rectangle centered, snapped, and inside the plan", () => {
    expect(
      placeStandardRect(
        { w: 1000, h: 800 },
        DEFAULT_STANDARD_RECT,
        { snap: true, spacing: 10 },
      ),
    ).toEqual({ x: 400, y: 325, w: 200, h: 150 });
  });

  it("falls back safely for malformed or out-of-range persisted preferences", () => {
    expect(readBoundedNumber("not-a-number", 10, 2, 200, true)).toBe(10);
    expect(readBoundedNumber("1", 10, 2, 200, true)).toBe(10);
    expect(readBoundedNumber("201", 10, 2, 200, true)).toBe(10);
    expect(readBoundedNumber("15.8", 10, 2, 200, true)).toBe(16);
    expect(readBoundedNumber(null, 10, 2, 200, true)).toBe(10);
  });
});

describe("Zone Editor grid controls", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps Snap off by default and renders the transformed grid only after enabling it", async () => {
    const { container } = setupEditor();
    const snap = container.querySelector('input[aria-label="Snap to grid"]') as HTMLInputElement;
    expect(snap.checked).toBe(false);
    expect(container.querySelector('[data-testid="zone-editor-grid"]')).toBeNull();

    await act(async () => {
      fireEvent.click(snap);
    });

    const grid = await waitFor(() =>
      container.querySelector('[data-testid="zone-editor-grid"]'),
    );
    expect(grid?.parentElement?.getAttribute("transform")).toContain("translate(");
    expect(grid?.getAttribute("data-grid-spacing")).toBe("10");
  });

  it("sets a standard rectangle size from a zone locally without an API mutation", async () => {
    const { container, fetchMock } = setupEditor();
    const zoneRect = await waitFor(() => {
      const rect = container.querySelector('rect[fill^="rgba(0, 112, 255"]');
      expect(rect).not.toBeNull();
      return rect;
    });
    await act(async () => {
      fireEvent.contextMenu(zoneRect!, { button: 2, clientX: 20, clientY: 30 });
    });
    const action = await waitFor(() => {
      const button = container.querySelector("button[data-zone-context-menu");
      expect(button).not.toBeNull();
      return button;
    });
    expect(action?.textContent).toContain("Set as standard rectangle size");

    await act(async () => {
      fireEvent.click(action!);
    });

    expect(localStorage.getItem("zoneEditorStandardWidth")).toBe("200");
    expect(localStorage.getItem("zoneEditorStandardHeight")).toBe("150");
    const mutations = fetchMock.mock.calls.filter(([, init]) =>
      ["POST", "PATCH", "DELETE"].includes((init?.method ?? "GET").toUpperCase()),
    );
    expect(mutations).toHaveLength(0);
  });

  it("places the standard rectangle in Draw mode and exposes resize handles", async () => {
    const { container } = setupEditor();
    const drawButton = await waitFor(() =>
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Draw Zone")),
    );
    await act(async () => {
      fireEvent.click(drawButton!);
    });
    const standard = container.querySelector('button[aria-label="Place standard rectangle"]');
    expect(standard).not.toBeNull();
    await act(async () => {
      fireEvent.click(standard!);
    });
    const pending = container.querySelector('rect[fill="rgba(0,112,255,0.15)"]');
    expect(pending).not.toBeNull();
    expect(container.querySelector('[data-testid="zone-editor-grid"]')).toBeNull();
  });
});