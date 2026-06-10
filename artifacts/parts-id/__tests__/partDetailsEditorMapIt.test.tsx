/**
 * @jest-environment node
 *
 * Tests for the "Map it!" button rendered inside PartDetailsEditor.
 *
 * Covered:
 *  1. Item with bin locations – pressing "Map it!" calls onClose() and
 *     onShowOnMap(item) each exactly once.
 *  2. Item with no bin locations – the button is still visible (bin count does
 *     not gate rendering); pressing it delegates the empty-bin toast logic to
 *     the caller's onShowOnMap handler.
 *  3. No onShowOnMap prop – the button is absent from the tree entirely.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type { InventoryItem } from "@workspace/api-client-react";

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
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
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
