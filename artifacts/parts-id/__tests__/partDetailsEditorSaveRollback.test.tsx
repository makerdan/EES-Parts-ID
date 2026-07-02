/**
 * @jest-environment node
 *
 * Verifies the snapshot/rollback behaviour added to PartDetailsEditor.handleSave:
 *
 *   A. On mutation failure, queryClient.invalidateQueries is called for both
 *      the `inventory` and `searchInventory` query keys so any partial optimistic
 *      cache patches left by individual mutations are overwritten with fresh
 *      server data (the onError rollback + onSettled safety-net).
 *
 *   B. On mutation success, queryClient.invalidateQueries is still called for
 *      both keys (onSettled safety-net always fires).
 *
 *   C. The onMutate snapshot is taken — getQueriesData is called once for
 *      `inventory` and once for `searchInventory` before the ops run.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";
import { Alert } from "react-native";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type { InventoryItem } from "@workspace/api-client-react";

// ─── Stable spies exposed to tests ───────────────────────────────────────────

const mockInvalidateQueries   = jest.fn().mockResolvedValue(undefined);
const mockGetQueriesData      = jest.fn().mockReturnValue([]);
const mockSetQueryData        = jest.fn();
const mockSetQueriesData      = jest.fn();
const mockInvalidateListCache = jest.fn().mockResolvedValue(undefined);

// Mutable reference – tests can swap mutateAsync to reject for failure cases.
const mockBinsMutateAsync     = jest.fn().mockResolvedValue(undefined);

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: () => null,
}));

jest.mock("@workspace/api-client-react", () => ({
  useUpdateItemBins:        jest.fn(() => ({ mutateAsync: (...a: unknown[]) => mockBinsMutateAsync(...a) })),
  useUpdateItemKeywords:    jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  getListInventoryQueryKey: jest.fn(() => ["inventory"]),
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    getQueriesData: (...a: unknown[]) => mockGetQueriesData(...a),
    setQueryData:   (...a: unknown[]) => mockSetQueryData(...a),
    setQueriesData: (...a: unknown[]) => mockSetQueriesData(...a),
    invalidateQueries: (...a: unknown[]) => mockInvalidateQueries(...a),
  })),
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",  foreground: "#000",  card: "#fff",
    border: "#ccc",      primary: "#3b82f6",  primaryForeground: "#fff",
    muted: "#f1f5f9",    mutedForeground: "#64748b",
    destructive: "#ef4444", success: "#22c55e", warning: "#f59e0b",
    accent: "#f1f5f9",   accentForeground: "#000",
  }),
}));

jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

jest.mock("@/utils/editItemCache", () => ({
  invalidateListCache: (...args: unknown[]) => mockInvalidateListCache(...args),
}));

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function renderEditor(ui: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(ui); });
  return tree;
}

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    catalog: "PART-X",
    description: "Original description",
    vendor: "ACME",
    binLocations: ["AISLE-01"],
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
  // Restore defaults after clearAllMocks wipes them.
  mockInvalidateQueries.mockResolvedValue(undefined);
  mockGetQueriesData.mockReturnValue([]);
  mockBinsMutateAsync.mockResolvedValue(undefined);
  mockInvalidateListCache.mockResolvedValue(undefined);
});

// Helper: make Alert.alert immediately call the destructive "Remove" callback.
function autoConfirmAlert() {
  (Alert.alert as jest.Mock).mockImplementation(
    (
      _title: string,
      _msg: string,
      buttons?: Array<{ style?: string; onPress?: () => void }>,
    ) => {
      const destructive = buttons?.find(b => b.style === "destructive");
      destructive?.onPress?.();
    },
  );
}

// =============================================================================
// A. Mutation failure → invalidateQueries called for both keys (rollback)
// =============================================================================

describe("PartDetailsEditor – handleSave rollback on mutation failure", () => {
  it("calls invalidateQueries for inventory and searchInventory when the bins mutation rejects", async () => {
    mockBinsMutateAsync.mockRejectedValue(new Error("network error"));
    autoConfirmAlert();

    const item = makeItem({ binLocations: ["AISLE-01"] });
    const tree = await renderEditor(
      <PartDetailsEditor
        item={item}
        adminToken="test-token"
        onClose={jest.fn()}
      />
    );
    activeTree = tree;

    // Remove the existing bin via Alert auto-confirm so bins state ≠ item.binLocations.
    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    expect(removeBinBtn).not.toBeNull();
    await act(async () => { removeBinBtn!.props.onPress(); });

    // Now bins state is [] but item.binLocations is ["AISLE-01"] → hasChanges = true.
    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });

    // onSettled must fire even on failure — both query keys must be invalidated.
    const invalidateCalls = mockInvalidateQueries.mock.calls.map(
      ([arg]: [{ queryKey: unknown[] }]) => arg.queryKey,
    );
    expect(invalidateCalls).toContainEqual(["searchInventory"]);

    // invalidateListCache is the invalidation path for the inventory key.
    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
  });

  it("restores cache snapshots (setQueryData) for both keys on failure", async () => {
    mockBinsMutateAsync.mockRejectedValue(new Error("network error"));
    // Return non-empty snapshots so we can assert they are restored.
    const fakeInvSnapshot: Array<[unknown[], unknown]> = [
      [["inventory", { page: 1 }], { items: [{ id: 42, description: "Old" }] }],
    ];
    const fakeSearchSnapshot: Array<[unknown[], unknown]> = [
      [["searchInventory", "widget"], { results: [], sizeUnknownResults: [] }],
    ];
    mockGetQueriesData
      .mockReturnValueOnce(fakeInvSnapshot)   // inventory snapshot
      .mockReturnValueOnce(fakeSearchSnapshot); // searchInventory snapshot
    autoConfirmAlert();

    const item = makeItem({ binLocations: ["AISLE-01"] });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    await act(async () => { removeBinBtn!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // setQueryData must have been called to restore each snapshot entry.
    const setQueryDataCalls = mockSetQueryData.mock.calls as Array<[unknown, unknown]>;
    const restoredKeys = setQueryDataCalls.map(([key]) => key);
    expect(restoredKeys).toContainEqual(["inventory", { page: 1 }]);
    expect(restoredKeys).toContainEqual(["searchInventory", "widget"]);
  });

  it("takes a cache snapshot BEFORE invoking mutateAsync (preserves true pre-mutation state)", async () => {
    // Track the global call order across both mocks.
    const callLog: Array<"getQueriesData" | "mutateAsync"> = [];
    mockGetQueriesData.mockImplementation(() => {
      callLog.push("getQueriesData");
      return [];
    });
    mockBinsMutateAsync.mockImplementation(async () => {
      callLog.push("mutateAsync");
      throw new Error("fail");
    });
    autoConfirmAlert();

    const item = makeItem({ binLocations: ["AISLE-01"] });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    await act(async () => { removeBinBtn!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // getQueriesData must have been called for inventory and searchInventory.
    expect(callLog.filter(e => e === "getQueriesData").length).toBeGreaterThanOrEqual(2);
    expect(callLog).toContain("mutateAsync");

    // All getQueriesData calls must appear BEFORE mutateAsync in the call log.
    const firstMutateIdx = callLog.indexOf("mutateAsync");
    const lastSnapshotIdx = callLog.lastIndexOf("getQueriesData");
    expect(lastSnapshotIdx).toBeLessThan(firstMutateIdx);
  });
});

// =============================================================================
// B. Mutation success → invalidateQueries still called (onSettled safety-net)
// =============================================================================

describe("PartDetailsEditor – handleSave onSettled invalidation on success", () => {
  it("calls invalidateQueries for searchInventory and invalidateListCache after a successful save", async () => {
    mockBinsMutateAsync.mockResolvedValue(undefined);
    autoConfirmAlert();

    const item = makeItem({ binLocations: ["AISLE-01"] });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    await act(async () => { removeBinBtn!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
    const invalidateCalls = mockInvalidateQueries.mock.calls.map(
      ([arg]: [{ queryKey: unknown[] }]) => arg.queryKey,
    );
    expect(invalidateCalls).toContainEqual(["searchInventory"]);
  });
});
