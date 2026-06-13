/**
 * @jest-environment node
 *
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
import renderer, { act } from "react-test-renderer";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type { InventoryItem } from "@workspace/api-client-react";

// Stable spy exposed to tests — prefixed "mock" so babel-jest hoists it
// alongside the jest.mock() call that references it.
const mockInvalidateQueries = jest.fn().mockResolvedValue(undefined);

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
  })),
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",  foreground: "#000",  card: "#fff",
    border: "#ccc",      primary: "#3b82f6",  primaryForeground: "#fff",
    muted: "#f1f5f9",    mutedForeground: "#64748b",
    destructive: "#ef4444", success: "#22c55e", warning: "#f59e0b",
    accent: "#f1f5f9",   accentForeground: "#000",
  }),
}));

// ─── @/components/DismissKeyboard ────────────────────────────────────────────

jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
}));

// ─── @/components/MeasurePartScreen ──────────────────────────────────────────

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

// ─── Suppress react-test-renderer deprecation warning ────────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") ||
          msg.includes("Warning:"))
      ) return;
      origConsoleError(msg, ...args);
    }
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Instance-tree helpers ────────────────────────────────────────────────────

type Inst = renderer.ReactTestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(c => instText(c as Inst | string)).join("");
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .findAll(n => (n.type as string) === "rn-pressable", { deep: true })
      .find(n => instText(n).includes(label)) ?? null
  );
}

function findPressableByA11yLabel(root: Inst, label: string): Inst | null {
  return (
    root
      .findAll(n => (n.type as string) === "rn-pressable", { deep: true })
      .find(n => n.props.accessibilityLabel === label) ?? null
  );
}

// ─── Render helper ────────────────────────────────────────────────────────────

async function renderEditor(ui: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(ui); });
  return tree;
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

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
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

    const tree = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={onClose}
        onShowOnMap={onShowOnMap}
      />
    );
    activeTree = tree;

    const btn = findPressable(tree.root, "Map it!");
    expect(btn).not.toBeNull();

    await act(async () => { btn!.props.onPress(); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledWith(item);
  });

  it("still renders the button and delegates to onShowOnMap when item has no bin locations", async () => {
    const onClose    = jest.fn();
    const onShowOnMap = jest.fn();
    const item = makeItem({ binLocations: [] });

    const tree = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={onClose}
        onShowOnMap={onShowOnMap}
      />
    );
    activeTree = tree;

    const btn = findPressable(tree.root, "Map it!");
    // Button must be present regardless of bin count — the toast for empty bins
    // is shown by the caller's handleShowOnMap, not by PartDetailsEditor itself.
    expect(btn).not.toBeNull();

    await act(async () => { btn!.props.onPress(); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledWith(item);
  });

  it("does not render the button when onShowOnMap prop is absent", async () => {
    const onClose = jest.fn();
    const item = makeItem();

    const tree = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={onClose}
      />
    );
    activeTree = tree;

    const btn = findPressable(tree.root, "Map it!");
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

    const tree = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = tree;

    const saveBtn = findPressable(tree.root, "Save Expanded Description");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });

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
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["inventory"] });

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

    const tree = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = tree;

    const saveBtn = findPressable(tree.root, "Save Expanded Description");
    await act(async () => { saveBtn!.props.onPress(); });

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

    const tree = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = tree;

    const clearBtn = findPressableByA11yLabel(tree.root, "Clear expanded description");
    expect(clearBtn).not.toBeNull();

    await act(async () => { clearBtn!.props.onPress(); });

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
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["inventory"] });

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

    const tree = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = tree;

    const saveBtn = findPressable(tree.root, "Save Expanded Description");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();

    const errorNodes = tree.root.findAll(
      n => typeof n.children?.[0] === "string" && (n.children[0] as string).includes("Unauthorized"),
      { deep: true },
    );
    expect(errorNodes.length).toBeGreaterThan(0);

    mockFetch.mockRestore();
  });
});
