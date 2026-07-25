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

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

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

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
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
// C. Partial failure: selective rollback — succeeded fields stay in cache
// =============================================================================

describe("PartDetailsEditor – selective cache rollback on partial failure", () => {
  it("calls setQueriesData to re-apply patches for succeeded fields when some ops fail", async () => {
    // Mock fetch: description PATCH succeeds, dimensions PATCH fails.
    // Policy: only failed fields are rolled back; succeeded fields remain visible
    // in the cache so the user sees what the server committed.
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn((url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? "GET").toUpperCase();
      if (method === "PATCH" && String(url).includes("/description")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
      }
      if (method === "PATCH" && String(url).includes("/dimensions")) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "DB error" }) } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    }) as jest.Mock;

    const item = makeItem({ description: "Original", dimensions: undefined });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Find description input by its placeholder (works regardless of type string).
    const descInput = tree.root.findAll(
      (n) => n.props?.placeholder === "Brief description of the part…",
      { deep: true },
    )[0];
    expect(descInput).toBeDefined();
    await act(async () => { descInput.props.onChangeText("New description"); });

    // Find first dimension TextInput (numeric keyboard) and change it.
    const dimInput = tree.root.findAll(
      (n) => n.props?.keyboardType === "numeric" && typeof n.props?.onChangeText === "function",
      { deep: true },
    )[0];
    expect(dimInput).toBeDefined();
    await act(async () => { dimInput.props.onChangeText("5"); });

    // Press Save.
    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    // setQueriesData MUST be called in the failure path — description succeeded
    // so its patch must be re-applied after the full-snapshot restore.
    expect(mockSetQueriesData).toHaveBeenCalled();
  });

  it("does NOT call setQueriesData in the failure path when all ops fail (no succeeded fields to preserve)", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(() => {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "DB error" }) } as Response);
    }) as jest.Mock;

    mockBinsMutateAsync.mockRejectedValue(new Error("Bins mutation failed"));
    autoConfirmAlert();

    const item = makeItem({ binLocations: ["AISLE-01"] });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Only remove the bin (triggers bins mutation) — no description change,
    // so no fetch PATCH is attempted. Bins mutation rejects → only op is bins
    // → no succeeded fields → setQueriesData should NOT be called.
    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    await act(async () => { removeBinBtn!.props.onPress(); });

    mockSetQueriesData.mockClear();

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // All ops failed — setQueriesData should NOT be called in the failure path
    // (no succeeded fields to re-apply).
    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });
});

// =============================================================================
// D. Stale existingDims — background refetch must not cause spurious PATCH
// =============================================================================

describe("PartDetailsEditor – stale existingDims bug (itemRef fix)", () => {
  /**
   * Regression: if handleSave uses `existingDims` from its render-time closure
   * instead of `itemRef.current?.dimensions`, a background refetch that arrives
   * AFTER the handler was created but BEFORE the user taps Save can leave
   * `existingDims` stale.  In that window, if the user also typed a dim value
   * that now matches the freshly-fetched server dims, the stale closure
   * compares against the OLD server value and fires a spurious PATCH.
   *
   * We simulate this by:
   *  1. Mounting with null dims, then having the user type "12" into dimLength.
   *  2. Capturing the save-button's onPress from that render (which closes over
   *     existingDims = null — the old server value).
   *  3. Simulating a background refetch via tree.update() so that
   *     itemRef.current.dimensions becomes { length: 12 } (server caught up).
   *  4. Calling the stale handler.
   *
   * With the OLD code (existingDims closure): oldDims = null, newDims = {length:12}
   * → dimsChanged = true → spurious PATCH.
   * With the FIX (itemRef.current?.dimensions): oldDims = {length:12}, newDims =
   * {length:12} → dimsChanged = false → no PATCH.
   */
  it("does NOT dispatch a spurious dimensions PATCH when a stale-closure handler runs after itemRef catches up to the server dims", async () => {
    const fetchSpy = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
    );
    (global as unknown as { fetch: jest.Mock }).fetch = fetchSpy;

    // Step 1: mount with no server dims; dim inputs initialise as "".
    const item = makeItem({ description: "Original", dimensions: undefined });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Step 2a: user types "12" into the first numeric dim input.
    const dimInput = tree.root.findAll(
      (n) => n.props?.keyboardType === "numeric" && typeof n.props?.onChangeText === "function",
      { deep: true },
    )[0];
    expect(dimInput).toBeDefined();
    await act(async () => { dimInput.props.onChangeText("12"); });

    // Step 2b: change description so there is always at least one op queued —
    // without this handleSave returns early before reaching the dims check.
    const descInput = tree.root.findAll(
      (n) => n.props?.placeholder === "Brief description of the part…",
      { deep: true },
    )[0];
    await act(async () => { descInput.props.onChangeText("Updated description"); });

    // Step 2c: capture the stale save handler NOW (closure has existingDims = null).
    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    const staleSaveHandler = saveBtn!.props.onPress as () => void;

    // Step 3: simulate a background refetch — item prop gets dims = {length:12}.
    // This commits a new render so itemRef.current.dimensions becomes {length:12}.
    // existingDims in the STALE handler closure is still null.
    const updatedItem = makeItem({
      description: "Original",
      dimensions: { length: 12, width: null, height: null, diameter: null },
    });
    await act(async () => {
      tree.update(
        <PartDetailsEditor item={updatedItem} adminToken="test-token" onClose={jest.fn()} />
      );
    });

    // Step 4: call the stale handler (pre-refetch closure).
    await act(async () => { staleSaveHandler(); });

    // With the fix, oldDims = itemRef.current?.dimensions = {length:12} which
    // matches newDims = {length:12} → dimsChanged = false → no PATCH for dims.
    const dimsPatchCalls = (fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>).filter(
      ([url, opts]) =>
        (opts?.method ?? "GET").toUpperCase() === "PATCH" &&
        String(url).includes("/dimensions"),
    );
    expect(dimsPatchCalls).toHaveLength(0);
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
