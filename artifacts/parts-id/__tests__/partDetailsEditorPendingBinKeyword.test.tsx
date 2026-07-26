/**
 * Guards the auto-pending bin/keyword logic in PartDetailsEditor.handleSave:
 *
 *   When the admin types text into the newBin or newKeyword input field but
 *   does NOT press the "Add" button before tapping "Save Details", handleSave
 *   must treat that text as a pending addition and include it in the mutation
 *   payload — so no data typed by the admin is silently dropped.
 *
 * Cases covered:
 *   1. Pending bin text is appended to the bins array sent to updateBinsMutation.
 *   2. Pending keyword text is appended (lowercased) to the keywords array sent
 *      to updateKeywordsMutation.
 *   3. Both pending bin and pending keyword are included in the same save.
 *   4. Pending bin/keyword that already exists in the array is NOT duplicated.
 *   5. Whitespace-only pending text is ignored (not added to the array).
 *   6. The cache patch (setQueriesData inventory updater) reflects the pending
 *      bin/keyword values so the list view is immediately up to date.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type { InventoryItem, InventoryListResponse } from "@workspace/api-client-react";

// ─── Stable spies exposed to tests ───────────────────────────────────────────

const mockInvalidateQueries   = jest.fn().mockResolvedValue(undefined);
const mockGetQueriesData      = jest.fn().mockReturnValue([]);
const mockSetQueryData        = jest.fn();
const mockSetQueriesData      = jest.fn();
const mockInvalidateListCache = jest.fn().mockResolvedValue(undefined);

const mockBinsMutateAsync     = jest.fn().mockResolvedValue(undefined);
const mockKeywordsMutateAsync = jest.fn().mockResolvedValue(undefined);

const mockAsyncStorageGetItem = jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null);
const mockAsyncStorageSetItem = jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined);

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
        testID:       props.testID ?? props.placeholder ?? "",
        value:        props.value,
        onChangeText: props.onChangeText,
        placeholder:  props.placeholder,
      }),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function findTextInput(root: Inst, placeholder: string): Inst | null {
  return (
    root
      .queryAll((n: TestInstance) => (n.type as string) === "rn-textinput", { includeSelf: true })
      .find((n: Inst) => n.props.testID === placeholder || n.props.placeholder === placeholder)
    ?? null
  );
}

async function renderEditor(ui: React.ReactElement) {
  const result = await render(ui);
  return result;
}

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    catalog:      "PART-X",
    description:  "Original description",
    vendor:       "ACME",
    binLocations: [],
    aiKeywords:   [],
    imageUrl:     null,
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
  jest.clearAllMocks();
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
// 1. Pending bin text is included in the bins mutation payload
// =============================================================================

describe("PartDetailsEditor – pending bin text is carried through on Save", () => {
  it("includes typed bin text in the bins mutation when Save is pressed without pressing Add", async () => {
    const item = makeItem({ binLocations: [], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    // Change description so the Save button is enabled (hasChanges = true).
    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    expect(descInput).not.toBeNull();
    await act(async () => { fireEvent.changeText(descInput!, "New description"); });

    // Type into the bin field but do NOT press Add.
    const binInput = findTextInput(result.root!, "e.g. A1-04");
    expect(binInput).not.toBeNull();
    await act(async () => { fireEvent.changeText(binInput!, "B2-07"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockBinsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockBinsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { binLocations: ["B2-07"] },
    });
  });

  it("appends pending bin to existing bins in the mutation payload", async () => {
    const item = makeItem({ binLocations: ["AISLE-01"], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "Updated description"); });

    const binInput = findTextInput(result.root!, "e.g. A1-04");
    expect(binInput).not.toBeNull();
    await act(async () => { fireEvent.changeText(binInput!, "C3-12"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockBinsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockBinsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { binLocations: ["AISLE-01", "C3-12"] },
    });
  });

  it("does NOT duplicate a pending bin that already exists in the bins list (case-insensitive)", async () => {
    const item = makeItem({ binLocations: ["AISLE-01"], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "Updated description"); });

    // Type a bin that already exists (different case).
    const binInput = findTextInput(result.root!, "e.g. A1-04");
    await act(async () => { fireEvent.changeText(binInput!, "aisle-01"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    // The duplicate is discarded: finalBins === bins (same reference, already equal
    // to item.binLocations) so no bins mutation fires at all.
    expect(mockBinsMutateAsync).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only pending bin text (does not add a blank bin)", async () => {
    const item = makeItem({ binLocations: [], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "Updated description"); });

    // Type whitespace only — should be treated as empty.
    const binInput = findTextInput(result.root!, "e.g. A1-04");
    await act(async () => { fireEvent.changeText(binInput!, "   "); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    // No bins mutation should fire (finalBins === [] === item.binLocations).
    expect(mockBinsMutateAsync).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 2. Pending keyword text is included in the keywords mutation payload
// =============================================================================

describe("PartDetailsEditor – pending keyword text is carried through on Save", () => {
  it("includes typed keyword text (lowercased) in the keywords mutation when Save is pressed without pressing Add", async () => {
    const item = makeItem({ aiKeywords: [], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "New description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    expect(kwInput).not.toBeNull();
    await act(async () => { fireEvent.changeText(kwInput!, "Motor"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockKeywordsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockKeywordsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { keywords: ["motor"] },
    });
  });

  it("appends pending keyword to existing keywords in the mutation payload", async () => {
    const item = makeItem({ aiKeywords: ["relay"], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "New description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { fireEvent.changeText(kwInput!, "Breaker"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockKeywordsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockKeywordsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { keywords: ["relay", "breaker"] },
    });
  });

  it("does NOT duplicate a pending keyword that already exists in the keywords list", async () => {
    const item = makeItem({ aiKeywords: ["motor"], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "New description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { fireEvent.changeText(kwInput!, "Motor"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    // The duplicate is discarded: finalKeywords === keywords (same reference,
    // already equal to item.aiKeywords) so no keywords mutation fires at all.
    expect(mockKeywordsMutateAsync).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only pending keyword text", async () => {
    const item = makeItem({ aiKeywords: [], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "Updated description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { fireEvent.changeText(kwInput!, "   "); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockKeywordsMutateAsync).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. Both pending bin AND keyword text are included together
// =============================================================================

describe("PartDetailsEditor – both pending bin and keyword text are carried through on Save", () => {
  it("includes both pending bin and pending keyword in their respective mutation payloads", async () => {
    const item = makeItem({ binLocations: [], aiKeywords: [], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "New description"); });

    const binInput = findTextInput(result.root!, "e.g. A1-04");
    await act(async () => { fireEvent.changeText(binInput!, "D4-22"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { fireEvent.changeText(kwInput!, "Contactor"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockBinsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockBinsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { binLocations: ["D4-22"] },
    });

    expect(mockKeywordsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockKeywordsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { keywords: ["contactor"] },
    });
  });
});

// =============================================================================
// 4. Cache patch (setQueriesData) reflects pending bin/keyword values
// =============================================================================

describe("PartDetailsEditor – cache patch reflects pending bin/keyword on Save", () => {
  it("inventory-list updater carries the pending bin value into the patched item", async () => {
    const item = makeItem({ binLocations: [], aiKeywords: [], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "New description"); });

    const binInput = findTextInput(result.root!, "e.g. A1-04");
    await act(async () => { fireEvent.changeText(binInput!, "E5-99"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockSetQueriesData).toHaveBeenCalledTimes(2);

    const [, inventoryUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];

    const fakeOld: InventoryListResponse = {
      items: [{ ...item } as InventoryItem],
      total: 1,
    } as unknown as InventoryListResponse;

    const patched = inventoryUpdater(fakeOld) as InventoryListResponse;
    const patchedItem = patched.items.find(i => i.id === 42)!;

    expect(patchedItem.binLocations).toEqual(["E5-99"]);
  });

  it("inventory-list updater carries the pending keyword value into the patched item", async () => {
    const item = makeItem({ binLocations: [], aiKeywords: [], description: "Old" });

    const result = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { fireEvent.changeText(descInput!, "New description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { fireEvent.changeText(kwInput!, "Fuse"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { fireEvent.press(saveBtn!); });

    expect(mockSetQueriesData).toHaveBeenCalledTimes(2);

    const [, inventoryUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];

    const fakeOld: InventoryListResponse = {
      items: [{ ...item } as InventoryItem],
      total: 1,
    } as unknown as InventoryListResponse;

    const patched = inventoryUpdater(fakeOld) as InventoryListResponse;
    const patchedItem = patched.items.find(i => i.id === 42)!;

    expect(patchedItem.aiKeywords).toEqual(["fuse"]);
  });
});
