/**
 * @jest-environment node
 *
 * Guards the synchronous cache-patch (success path) and snapshot-restore
 * (partial-failure path) contracts in PartDetailsEditor.handleSave:
 *
 *   SUCCESS PATH
 *   After Promise.allSettled resolves with all ops fulfilled, setQueriesData
 *   is called for both the inventory-list and searchInventory caches, and the
 *   updater function it receives patches ALL mutated fields (description, bins,
 *   keywords, dimensions) to their new values — no refetch is required for the
 *   list view to reflect the change.
 *
 *   PARTIAL-FAILURE PATH
 *   When one or more ops reject, setQueriesData is NOT called (no partial
 *   write is ever visible in either cache), and setQueryData IS called to
 *   restore both caches to their pre-mutation snapshot state.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";
import { Alert } from "react-native";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type { InventoryItem, InventoryListResponse, SearchInventoryResponse } from "@workspace/api-client-react";

// ─── Stable spies exposed to tests ───────────────────────────────────────────

const mockInvalidateQueries   = jest.fn().mockResolvedValue(undefined);
const mockGetQueriesData      = jest.fn().mockReturnValue([]);
const mockSetQueryData        = jest.fn();
const mockSetQueriesData      = jest.fn();
const mockInvalidateListCache = jest.fn().mockResolvedValue(undefined);

// Mutable references — tests can swap mutateAsync to reject for failure cases.
const mockBinsMutateAsync     = jest.fn().mockResolvedValue(undefined);
const mockKeywordsMutateAsync = jest.fn().mockResolvedValue(undefined);

// AsyncStorage mock — success path reads QUERY_CACHE_KEY; keep it simple.
const mockAsyncStorageGetItem = jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null);
const mockAsyncStorageSetItem = jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined);

// Fetch mock — description and dimensions PATCHes use raw fetch.
const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: jest.fn().mockResolvedValue({}),
});
(global as unknown as { fetch: unknown }).fetch = mockFetch;

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: () => null,
}));

jest.mock("@workspace/api-client-react", () => ({
  useUpdateItemBins:        jest.fn(() => ({ mutateAsync: (...a: unknown[]) => mockBinsMutateAsync(...a) })),
  useUpdateItemKeywords:    jest.fn(() => ({ mutateAsync: (...a: unknown[]) => mockKeywordsMutateAsync(...a) })),
  getListInventoryQueryKey: jest.fn(() => ["inventory"]),
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    getQueriesData:    (...a: unknown[]) => mockGetQueriesData(...a),
    setQueryData:      (...a: unknown[]) => mockSetQueryData(...a),
    setQueriesData:    (...a: unknown[]) => mockSetQueriesData(...a),
    invalidateQueries: (...a: unknown[]) => mockInvalidateQueries(...a),
  })),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:  (...a: [string])          => mockAsyncStorageGetItem(...a),
    setItem:  (...a: [string, string])  => mockAsyncStorageSetItem(...a),
  },
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
  invalidateListCache:           (...args: unknown[]) => mockInvalidateListCache(...args),
  evictDeletedItemFromAllCaches: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

// Mock KeyboardDoneInput to render a View that carries onChangeText as a prop
// so tests can locate specific fields by testID and drive text changes.
jest.mock("@/components/KeyboardDoneInput", () => {
  const Rct = require("react");
  return {
    KeyboardDoneInput: (props: {
      placeholder?: string;
      onChangeText?: (v: string) => void;
      value?: string;
      testID?: string;
      [k: string]: unknown;
    }) =>
      Rct.createElement("rn-textinput", {
        testID:         props.testID ?? props.placeholder ?? "",
        value:          props.value,
        onChangeText:   props.onChangeText,
        placeholder:    props.placeholder,
      }),
  };
});

// ─── Suppress react-test-renderer deprecation warnings ───────────────────────

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

/** Find a KeyboardDoneInput (rendered as rn-textinput) by its testID/placeholder. */
function findTextInput(root: Inst, placeholder: string): Inst | null {
  return (
    root
      .findAll(n => (n.type as string) === "rn-textinput", { deep: true })
      .find(n => n.props.testID === placeholder || n.props.placeholder === placeholder)
    ?? null
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
    catalog:      "PART-X",
    description:  "Old description",
    vendor:       "ACME",
    binLocations: ["AISLE-01"],
    aiKeywords:   ["relay"],
    imageUrl:     null,
    ...overrides,
  } as unknown as InventoryItem;
}

/** Auto-confirm the destructive "Remove" alert so bin removal fires. */
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

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  jest.clearAllMocks();
  // Restore defaults wiped by clearAllMocks.
  mockInvalidateQueries.mockResolvedValue(undefined);
  mockGetQueriesData.mockReturnValue([]);
  mockBinsMutateAsync.mockResolvedValue(undefined);
  mockKeywordsMutateAsync.mockResolvedValue(undefined);
  mockInvalidateListCache.mockResolvedValue(undefined);
  mockAsyncStorageGetItem.mockResolvedValue(null);
  mockAsyncStorageSetItem.mockResolvedValue(undefined);
  mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
});

// =============================================================================
// SUCCESS PATH — setQueriesData is called with the patched field values
// =============================================================================

describe("PartDetailsEditor – handleSave success path cache patch", () => {
  /**
   * Multi-field success test: change description AND remove a keyword AND
   * remove a bin so that all three fields in the patch differ from the
   * original item. The updater must apply each new value independently —
   * a regression that drops any single field line from patchItem cannot pass.
   */
  it("patches description, keywords, and binLocations to their NEW values in the inventory-list updater", async () => {
    autoConfirmAlert();

    const item = makeItem({
      description:  "Old description",
      aiKeywords:   ["relay"],
      binLocations: ["AISLE-01"],
    });

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // 1. Change description via the KeyboardDoneInput mock.
    const descInput = findTextInput(tree.root, "Brief description of the part\u2026");
    expect(descInput).not.toBeNull();
    await act(async () => { descInput!.props.onChangeText("New description"); });

    // 2. Remove the "relay" keyword chip.
    const relayChip = findPressable(tree.root, "relay");
    expect(relayChip).not.toBeNull();
    await act(async () => { relayChip!.props.onPress(); });

    // 3. Remove the bin.
    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    expect(removeBinBtn).not.toBeNull();
    await act(async () => { removeBinBtn!.props.onPress(); });

    // 4. Save — fetch succeeds for description, mutations resolve for bins/keywords.
    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    // setQueriesData must have been called twice: once for inventory-list,
    // once for searchInventory.
    expect(mockSetQueriesData).toHaveBeenCalledTimes(2);

    // Extract the inventory-list updater from the first setQueriesData call.
    const [, inventoryUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];
    expect(typeof inventoryUpdater).toBe("function");

    const fakeOld: InventoryListResponse = {
      items: [
        { ...item } as InventoryItem,
        { id: 99, catalog: "OTHER", description: "Untouched" } as unknown as InventoryItem,
      ],
      total: 2,
    } as unknown as InventoryListResponse;

    const patched = inventoryUpdater(fakeOld) as InventoryListResponse;
    const patchedItem = patched.items.find(i => i.id === 42)!;

    // Each mutated field must carry the NEW value, not the old one.
    expect(patchedItem.description).toBe("New description");
    expect(patchedItem.binLocations).toEqual([]);
    expect(patchedItem.aiKeywords).toEqual([]);

    // Unrelated items must not be modified.
    const other = patched.items.find(i => i.id === 99)!;
    expect(other.description).toBe("Untouched");
  });

  it("patches the same fields in the searchInventory updater (results and sizeUnknownResults)", async () => {
    autoConfirmAlert();

    const item = makeItem({
      description:  "Old description",
      aiKeywords:   ["relay"],
      binLocations: ["AISLE-01"],
    });

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    const descInput = findTextInput(tree.root, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("New description"); });

    const relayChip = findPressable(tree.root, "relay");
    await act(async () => { relayChip!.props.onPress(); });

    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    await act(async () => { removeBinBtn!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockSetQueriesData.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Extract the searchInventory updater from the second setQueriesData call.
    const [, searchUpdater] = mockSetQueriesData.mock.calls[1] as [
      unknown,
      (old: SearchInventoryResponse | undefined) => SearchInventoryResponse | undefined,
    ];
    expect(typeof searchUpdater).toBe("function");

    const fakeSearchOld: SearchInventoryResponse = {
      results: [
        { item: { ...item } as InventoryItem, score: 1 },
        { item: { id: 99, catalog: "OTHER", description: "Untouched" } as unknown as InventoryItem, score: 0.5 },
      ],
      sizeUnknownResults: [
        { item: { ...item } as InventoryItem, score: 0.9 },
      ],
    } as unknown as SearchInventoryResponse;

    const patched = searchUpdater(fakeSearchOld) as SearchInventoryResponse;

    const r = patched.results.find(x => x.item.id === 42)!;
    expect(r.item.description).toBe("New description");
    expect(r.item.binLocations).toEqual([]);
    expect(r.item.aiKeywords).toEqual([]);

    const su = patched.sizeUnknownResults?.find(x => x.item.id === 42)!;
    expect(su.item.description).toBe("New description");
    expect(su.item.binLocations).toEqual([]);
    expect(su.item.aiKeywords).toEqual([]);

    // dimensions must also be carried through (parsed from the item's null dims).
    expect(r.item).toHaveProperty("dimensions");
    expect(su.item).toHaveProperty("dimensions");

    // Unrelated item untouched.
    expect(patched.results.find(x => x.item.id === 99)!.item.description).toBe("Untouched");
  });

  it("includes dimensions in the patch when item has existing dimensions", async () => {
    autoConfirmAlert();

    const item = makeItem({
      description:  "Old description",
      binLocations: ["AISLE-01"],
      aiKeywords:   [],
      dimensions:   { length: 10, width: 5, height: 2, diameter: null } as unknown as InventoryItem["dimensions"],
    });

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Change bins only — dimensions state is untouched (no change), but
    // patchItem must still carry the existing dimension values forward.
    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    expect(removeBinBtn).not.toBeNull();
    await act(async () => { removeBinBtn!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockSetQueriesData).toHaveBeenCalledTimes(2);

    const [, inventoryUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];

    const fakeOld: InventoryListResponse = {
      items: [{ ...item, dimensions: { length: 10, width: 5, height: 2, diameter: null } } as unknown as InventoryItem],
      total: 1,
    } as unknown as InventoryListResponse;

    const patched = inventoryUpdater(fakeOld) as InventoryListResponse;
    const patchedItem = patched.items[0]!;

    // dimensions must be present in the patch with the correct parsed values.
    expect(patchedItem.dimensions).toBeDefined();
    // length = 10, width = 5, height = 2 were the item's initial values
    expect((patchedItem.dimensions as { length?: number | null }).length).toBe(10);
    expect((patchedItem.dimensions as { width?: number | null }).width).toBe(5);
    expect((patchedItem.dimensions as { height?: number | null }).height).toBe(2);
  });

  it("updater returns old unchanged when called with undefined (no-op guard)", async () => {
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

    const [, inventoryUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];

    expect(inventoryUpdater(undefined)).toBeUndefined();
  });
});

// =============================================================================
// PARTIAL-FAILURE PATH — no partial write, snapshot is restored
// =============================================================================

describe("PartDetailsEditor – handleSave partial-failure path: no partial write visible", () => {
  it("does NOT call setQueriesData when the bins mutation rejects (no partial patch applied)", async () => {
    mockBinsMutateAsync.mockRejectedValue(new Error("network error"));
    autoConfirmAlert();

    const item = makeItem({ binLocations: ["AISLE-01"] });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    expect(removeBinBtn).not.toBeNull();
    await act(async () => { removeBinBtn!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    // The synchronous patch must never run when any op fails.
    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });

  it("does NOT call setQueriesData when the description PATCH fails alongside a succeeding bins op", async () => {
    // Description PATCH returns HTTP 500; bins mutation succeeds.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: jest.fn().mockResolvedValue({ error: "Internal Server Error" }),
    });
    autoConfirmAlert();

    const item = makeItem({
      description:  "Old description",
      binLocations: ["AISLE-01"],
    });

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Change description (triggers the fetch PATCH that will fail).
    const descInput = findTextInput(tree.root, "Brief description of the part\u2026");
    expect(descInput).not.toBeNull();
    await act(async () => { descInput!.props.onChangeText("New description"); });

    // Change bins too (mutation succeeds) — partial failure scenario.
    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    await act(async () => { removeBinBtn!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // Even though bins mutation succeeded, the partially-failed set must not
    // write any new values into the cache.
    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });

  it("restores both cache snapshots via setQueryData when the bins mutation rejects", async () => {
    mockBinsMutateAsync.mockRejectedValue(new Error("network error"));

    const fakeInvSnapshot: Array<[unknown[], unknown]> = [
      [["inventory", { page: 1 }], { items: [{ id: 42, description: "Old", binLocations: ["AISLE-01"] }] }],
    ];
    const fakeSearchSnapshot: Array<[unknown[], unknown]> = [
      [["searchInventory", "widget"], { results: [{ item: { id: 42, binLocations: ["AISLE-01"] } }], sizeUnknownResults: [] }],
    ];
    mockGetQueriesData
      .mockReturnValueOnce(fakeInvSnapshot)
      .mockReturnValueOnce(fakeSearchSnapshot);

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

    // setQueryData must restore every snapshot entry.
    const restoredKeys = (mockSetQueryData.mock.calls as Array<[unknown, unknown]>).map(
      ([key]) => key,
    );
    expect(restoredKeys).toContainEqual(["inventory", { page: 1 }]);
    expect(restoredKeys).toContainEqual(["searchInventory", "widget"]);

    // No partial patch must have been applied.
    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });

  it("restores snapshot with the exact pre-mutation data values (not the attempted new values)", async () => {
    mockBinsMutateAsync.mockRejectedValue(new Error("server rejected"));

    const preMutationItems = [{ id: 42, description: "Old description", binLocations: ["AISLE-01"] }];
    const fakeInvSnapshot: Array<[unknown[], unknown]> = [
      [["inventory", {}], { items: preMutationItems, total: 1 }],
    ];
    mockGetQueriesData
      .mockReturnValueOnce(fakeInvSnapshot)
      .mockReturnValueOnce([]);

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

    // Find the setQueryData call that restored the inventory snapshot.
    const calls = mockSetQueryData.mock.calls as Array<[unknown, unknown]>;
    const invCall = calls.find(([key]) => JSON.stringify(key) === JSON.stringify(["inventory", {}]));
    expect(invCall).toBeDefined();

    // The restored data must be exactly the pre-mutation snapshot (old bins).
    const restoredData = invCall![1] as { items: typeof preMutationItems };
    expect(restoredData.items[0].binLocations).toEqual(["AISLE-01"]);
  });
});

// =============================================================================
// 401 SESSION-EXPIRED PATH — bins mutation rejects with a 401 error
// =============================================================================

describe("PartDetailsEditor – handleSave 401 session-expired error", () => {
  it("shows the session-expired message in the bins field error when the mutation rejects with a 401 error", async () => {
    mockBinsMutateAsync.mockRejectedValue(new Error("401 Unauthorized"));
    autoConfirmAlert();

    const item = makeItem({ binLocations: ["AISLE-01"] });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Remove the bin so the bins op is enqueued.
    const removeBinBtn = findPressableByA11yLabel(tree.root, "Remove bin AISLE-01");
    expect(removeBinBtn).not.toBeNull();
    await act(async () => { removeBinBtn!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    // The rendered tree must contain a Text node with the session-expired copy.
    const allTexts = tree.root
      .findAll(n => (n.type as string) === "rn-text", { deep: true })
      .map(n => instText(n));
    const sessionExpiredNode = allTexts.find(t =>
      t.includes("Session expired") && t.includes("re-unlock admin access")
    );
    expect(sessionExpiredNode).toBeDefined();

    // The synchronous cache patch must NOT have run.
    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });

  it("shows the session-expired message in the description field error when the description PATCH returns 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({}),
    });

    const item = makeItem({ description: "Old description" });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Change only the description — no bins/dims change, so description is the sole op.
    const descInput = findTextInput(tree.root, "Brief description of the part\u2026");
    expect(descInput).not.toBeNull();
    await act(async () => { descInput!.props.onChangeText("New description"); });

    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    // The rendered tree must contain the session-expired copy (not the generic
    // "check connection" message) because the server returned 401.
    const allTexts = tree.root
      .findAll(n => (n.type as string) === "rn-text", { deep: true })
      .map(n => instText(n));
    const sessionExpiredNode = allTexts.find(t =>
      t.includes("Session expired") && t.includes("re-unlock admin access")
    );
    expect(sessionExpiredNode).toBeDefined();

    // No partial cache patch should have been applied.
    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });

  it("shows the session-expired message in the dimensions field error when the dimensions PATCH returns 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({}),
    });

    // Item with no existing dimensions so any typed value is a change.
    const item = makeItem({ description: "Old description" });
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Type a length value — all dim inputs share placeholder "–"; find() returns
    // the first one (Length), which is enough to mark dimsChanged = true.
    const lengthInput = findTextInput(tree.root, "\u2013");
    expect(lengthInput).not.toBeNull();
    await act(async () => { lengthInput!.props.onChangeText("50"); });

    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    // Session-expired text must be present for the dimensions op (not the
    // generic "check connection" fallback).
    const allTexts = tree.root
      .findAll(n => (n.type as string) === "rn-text", { deep: true })
      .map(n => instText(n));
    const sessionExpiredNode = allTexts.find(t =>
      t.includes("Session expired") && t.includes("re-unlock admin access")
    );
    expect(sessionExpiredNode).toBeDefined();

    // No partial cache patch should have been applied.
    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });
});
