/**
 * Tests for PartDetailsEditor covering two independent save paths:
 *
 *  A. "Map it!" button
 *     1. Item with bin locations – pressing "Map it!" calls onClose() and
 *        onShowOnMap(item) each exactly once.
 *     2. Item with no bin locations – the button is still visible (bin count does
 *        not gate rendering); pressing it delegates the empty-bin toast logic to
 *        the caller's onShowOnMap handler.
 *     3. No onShowOnMap prop – the button is absent from the tree entirely.
 *
 *  B. Expanded-description save path (handleSaveExpandedDesc /
 *     handleClearExpandedDesc)
 *     4. Save – PATCHes the correct endpoint with trimmed text and calls
 *        queryClient.invalidateQueries on success.
 *     5. Clear – PATCHes the correct endpoint with null and calls
 *        queryClient.invalidateQueries on success.
 *     6. Save error – shows the server error message when fetch responds !ok.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type { InventoryItem } from "@workspace/api-client-react";

// Stable spy exposed to tests — prefixed "mock" so babel-jest hoists it
// alongside the jest.mock() call that references it.
const mockInvalidateQueries = jest.fn().mockResolvedValue(undefined);

// Captures the onConfirm callback that PartDetailsEditor passes to
// MeasurePartScreen so tests can invoke handleMeasureConfirm directly.
let mockMeasureOnConfirm: ((dims: { length: number | null; width: number | null; height: number | null; diameter: number | null }) => void) | null = null;

// Spy for the shared invalidateListCache utility.
const mockInvalidateListCache = jest.fn().mockResolvedValue(undefined);

// ─── @/utils/apiBase ─────────────────────────────────────────────────────────

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

// ─── @/components/PartPhotoPicker ────────────────────────────────────────────

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: () => null,
}));

// ─── @workspace/api-client-react ─────────────────────────────────────────────

jest.mock("@workspace/api-client-react", () => ({
  useUpdateItemBins:      jest.fn(() => ({ mutateAsync: jest.fn() })),
  useUpdateItemKeywords:  jest.fn(() => ({ mutateAsync: jest.fn() })),
  getListInventoryQueryKey: jest.fn(() => ["inventory"]),
}));

// ─── @tanstack/react-query ───────────────────────────────────────────────────

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    invalidateQueries: mockInvalidateQueries,
    // The expanded-description save path patches cached query data in place
    // before invalidating — the mock must expose it or the save handler throws
    // and never reaches invalidateQueries.
    setQueriesData: jest.fn(),
  })),
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── @/components/DismissKeyboard ────────────────────────────────────────────

jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
}));

// ─── @/components/MeasurePartScreen ──────────────────────────────────────────
// Captures onConfirm so tests can invoke handleMeasureConfirm directly.

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: (props: { onConfirm?: (dims: { length: number | null; width: number | null; height: number | null; diameter: number | null }) => void; visible?: boolean }) => {
    mockMeasureOnConfirm = props.onConfirm ?? null;
    return null;
  },
}));

// ─── @/utils/editItemCache ────────────────────────────────────────────────────

jest.mock("@/utils/editItemCache", () => ({
  invalidateListCache: (...args: unknown[]) => mockInvalidateListCache(...args),
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

// ─── Instance-tree helpers ────────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((c: Inst | string) => instText(c as Inst | string)).join("");
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll((n: TestInstance) => (n.type as string) === "rn-pressable", { includeSelf: true })
      .find((n: Inst) => instText(n).includes(label)) ?? null
  );
}

function findPressableByA11yLabel(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll((n: TestInstance) => (n.type as string) === "rn-pressable", { includeSelf: true })
      .find((n: Inst) => n.props.accessibilityLabel === label) ?? null
  );
}

// ─── Render helper ────────────────────────────────────────────────────────────

async function renderEditor(ui: React.ReactElement) {
  const result = await render(ui);
  return result;
}

// ─── Item fixture ─────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 1,
    catalog: "WIDGET-A",
    description: "Test widget",
    vendor: "ACME",
    binLocations: ["05-02-001"],
    aiKeywords: [],
    imageUrl: null,
    ...overrides,
  } as unknown as InventoryItem;
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  mockMeasureOnConfirm = null;
  jest.clearAllMocks();
});

// =============================================================================
// PartDetailsEditor – "Map it!" button
// =============================================================================

describe('PartDetailsEditor – "Map it!" button', () => {
  it("calls onClose() and onShowOnMap(item) each once when pressed with a binned item", async () => {
    const onClose    = jest.fn();
    const onShowOnMap = jest.fn();
    const item = makeItem({ binLocations: ["05-02-001"] });

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={onClose}
        onShowOnMap={onShowOnMap}
      />
    );
    activeTree = result;

    const btn = findPressable(result.root!, "Map it!");
    expect(btn).not.toBeNull();

    await act(async () => { fireEvent.press(btn!); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledWith(item);
  });

  it("still renders the button and delegates to onShowOnMap when item has no bin locations", async () => {
    const onClose    = jest.fn();
    const onShowOnMap = jest.fn();
    const item = makeItem({ binLocations: [] });

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={onClose}
        onShowOnMap={onShowOnMap}
      />
    );
    activeTree = result;

    const btn = findPressable(result.root!, "Map it!");
    // Button must be present regardless of bin count — the toast for empty bins
    // is shown by the caller's handleShowOnMap, not by PartDetailsEditor itself.
    expect(btn).not.toBeNull();

    await act(async () => { fireEvent.press(btn!); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledWith(item);
  });

  it("does not render the button when onShowOnMap prop is absent", async () => {
    const onClose = jest.fn();
    const item = makeItem();

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={onClose}
      />
    );
    activeTree = result;

    const btn = findPressable(result.root!, "Map it!");
    expect(btn).toBeNull();
  });
});

// =============================================================================
// PartDetailsEditor – expanded-description save path
// =============================================================================

describe("PartDetailsEditor – expanded-description save path", () => {
  it("PATCHes the correct endpoint with the current text and invalidates queries on success", async () => {
    const mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({}),
    } as unknown as Response);

    const item = makeItem({
      binLocations: [],
      // expandedDescription is set so the field pre-fills with text
      expandedDescription: "Original AI-generated notes about this part",
    } as unknown as Partial<InventoryItem>);

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = result;

    const saveBtn = findPressable(result.root!, "Save Expanded Description");
    expect(saveBtn).not.toBeNull();

    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/inventory\/1\/expanded-description$/);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      expandedDescription: "Original AI-generated notes about this part",
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["searchInventory"] });

    mockFetch.mockRestore();
  });

  it("trims leading and trailing whitespace from the description before saving", async () => {
    const mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({}),
    } as unknown as Response);

    const item = makeItem({
      binLocations: [],
      expandedDescription: "  padded text with spaces  ",
    } as unknown as Partial<InventoryItem>);

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = result;

    const saveBtn = findPressable(result.root!, "Save Expanded Description");
    await act(async () => { fireEvent.press(saveBtn!); });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      expandedDescription: "padded text with spaces",
    });

    mockFetch.mockRestore();
  });

  it("PATCHes the correct endpoint with null and invalidates queries when clearing", async () => {
    const mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({}),
    } as unknown as Response);

    const item = makeItem({
      binLocations: [],
      expandedDescription: "Some existing description to clear",
    } as unknown as Partial<InventoryItem>);

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = result;

    const clearBtn = findPressableByA11yLabel(result.root!, "Clear expanded description");
    expect(clearBtn).not.toBeNull();

    await act(async () => { fireEvent.press(clearBtn!); });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/inventory\/1\/expanded-description$/);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    });
    expect(JSON.parse(init.body as string)).toEqual({ expandedDescription: null });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["searchInventory"] });

    mockFetch.mockRestore();
  });

  it("shows the server error message and does not invalidate queries when fetch responds !ok", async () => {
    const mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      json: jest.fn().mockResolvedValue({ error: "Unauthorized" }),
    } as unknown as Response);

    const item = makeItem({
      binLocations: [],
      expandedDescription: "Some text",
    } as unknown as Partial<InventoryItem>);

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = result;

    const saveBtn = findPressable(result.root!, "Save Expanded Description");
    expect(saveBtn).not.toBeNull();

    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();

    const errorNodes = result.root!.queryAll(
      (n: TestInstance) => typeof n.children?.[0] === "string" && (n.children[0] as string).includes("Unauthorized"),
      { includeSelf: true },
    );
    expect(errorNodes.length).toBeGreaterThan(0);

    mockFetch.mockRestore();
  });
});

// =============================================================================
// PartDetailsEditor – dimensions save path (handleMeasureConfirm)
// =============================================================================

describe("PartDetailsEditor – dimensions save path", () => {
  const TEST_DIMS = { length: 120, width: 80, height: 45, diameter: null };

  it("PATCHes the correct endpoint with all dimension fields and calls invalidateListCache + invalidateQueries on success", async () => {
    const mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({}),
    } as unknown as Response);

    const item = makeItem({ binLocations: [] });

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = result;

    expect(mockMeasureOnConfirm).not.toBeNull();

    await act(async () => { mockMeasureOnConfirm!(TEST_DIMS); });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/inventory\/1\/dimensions$/);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    });
    expect(JSON.parse(init.body as string)).toEqual(TEST_DIMS);

    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["searchInventory"] });

    mockFetch.mockRestore();
  });

  it("shows a user-visible error and does not call invalidateListCache when fetch responds !ok", async () => {
    const mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      json: jest.fn().mockResolvedValue({ error: "Write failed" }),
    } as unknown as Response);

    const item = makeItem({ binLocations: [] });

    const result = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = result;

    expect(mockMeasureOnConfirm).not.toBeNull();

    await act(async () => { mockMeasureOnConfirm!(TEST_DIMS); });

    expect(mockInvalidateListCache).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();

    const errorNodes = result.root!.queryAll(
      (n: TestInstance) => typeof n.children?.[0] === "string" &&
        (n.children[0] as string).includes("Could not save dimensions"),
      { includeSelf: true },
    );
    expect(errorNodes.length).toBeGreaterThan(0);

    mockFetch.mockRestore();
  });
});
