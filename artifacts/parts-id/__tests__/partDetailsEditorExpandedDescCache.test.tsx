/**
 * @jest-environment node
 *
 * Regression hardening for two cache-patch contracts added to PartDetailsEditor:
 *
 *   A. EXPANDED DESCRIPTION SAVE (handleSaveExpandedDesc)
 *      After a successful PATCH, setQueriesData is called synchronously for BOTH
 *      the inventory-list cache AND the searchInventory cache, patching
 *      expandedDescription to the saved value.  invalidateQueries is subsequently
 *      called for ["searchInventory"] so remote data is refreshed.
 *
 *   B. EXPANDED DESCRIPTION CLEAR (handleClearExpandedDesc)
 *      Same contract as (A) but sets expandedDescription: null in both caches.
 *
 *   C. THUMBNAIL URL CLEARED ON PHOTO SAVE (patchItem in handleSave)
 *      When a photo is saved successfully, the setQueriesData updater sets
 *      thumbnailUrl: null (slot 1) or thumbnailUrl2: null (slot 2) alongside
 *      imageUrl/imageUrl2, so ResultCard falls back to the fresh imageUrl
 *      immediately without waiting for a background refetch to return the new
 *      thumbnail URL.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type {
  InventoryItem,
  InventoryListResponse,
  SearchInventoryResponse,
} from "@workspace/api-client-react";

// ─── Stable spies ─────────────────────────────────────────────────────────────

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

/**
 * PartPhotoPicker: exposed as a pressable with testID "photo-picker-{slot}" so
 * tests can trigger photo selection by pressing it, which calls onChange with a
 * fake local URI — the same path as a real user picking a photo.
 */
jest.mock("@/components/PartPhotoPicker", () => {
  const Rct = require("react");
  return {
    PartPhotoPicker: (props: {
      slot: number;
      onChange?: (uri: string | null) => void;
    }) =>
      Rct.createElement("rn-pressable", {
        testID: `photo-picker-${props.slot}`,
        onPress: () => props.onChange?.("file://test-photo.jpg"),
      }),
  };
});

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
    getItem:  (...a: [string])         => mockAsyncStorageGetItem(...a),
    setItem:  (...a: [string, string]) => mockAsyncStorageSetItem(...a),
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

// ─── Suppress deprecation warnings ───────────────────────────────────────────

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
    },
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Per-test cleanup ─────────────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function findPressableByTestID(root: Inst, testID: string): Inst | null {
  return (
    root
      .findAll(n => (n.type as string) === "rn-pressable", { deep: true })
      .find(n => n.props.testID === testID) ?? null
  );
}

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
    id:           42,
    catalog:      "PART-X",
    description:  "Old description",
    vendor:       "ACME",
    binLocations: [],
    aiKeywords:   [],
    imageUrl:     null,
    imageUrl2:    null,
    thumbnailUrl:  null,
    thumbnailUrl2: null,
    ...overrides,
  } as unknown as InventoryItem;
}

// =============================================================================
// A. handleSaveExpandedDesc — synchronous cache patches + invalidation
// =============================================================================

describe("PartDetailsEditor – handleSaveExpandedDesc cache patch", () => {
  it("calls setQueriesData twice (list + search) after a successful PATCH", async () => {
    const item = makeItem();

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    // Type text into the expanded-description field to enable the save button.
    const expandedInput = findTextInput(tree.root, "No expanded description yet\u2026");
    expect(expandedInput).not.toBeNull();
    await act(async () => { expandedInput!.props.onChangeText("Full details here."); });

    const saveExpandedBtn = findPressable(tree.root, "Save Expanded Description");
    expect(saveExpandedBtn).not.toBeNull();
    await act(async () => { saveExpandedBtn!.props.onPress(); });

    expect(mockSetQueriesData).toHaveBeenCalledTimes(2);
  });

  it("list-cache updater patches expandedDescription to the saved text", async () => {
    const item = makeItem();

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const expandedInput = findTextInput(tree.root, "No expanded description yet\u2026");
    await act(async () => { expandedInput!.props.onChangeText("Full details here."); });

    const saveExpandedBtn = findPressable(tree.root, "Save Expanded Description");
    await act(async () => { saveExpandedBtn!.props.onPress(); });

    const [, listUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];
    expect(typeof listUpdater).toBe("function");

    const fakeOld: InventoryListResponse = {
      items: [
        { ...item } as InventoryItem,
        { id: 99, catalog: "OTHER" } as unknown as InventoryItem,
      ],
      total: 2,
    } as unknown as InventoryListResponse;

    const patched = listUpdater(fakeOld) as InventoryListResponse;

    // Target item must carry the new expandedDescription value.
    expect(patched.items.find(i => i.id === 42)!.expandedDescription).toBe("Full details here.");
    // Unrelated item must be untouched.
    expect(patched.items.find(i => i.id === 99)!.expandedDescription).toBeUndefined();
  });

  it("search-cache updater patches expandedDescription in results and sizeUnknownResults", async () => {
    const item = makeItem();

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const expandedInput = findTextInput(tree.root, "No expanded description yet\u2026");
    await act(async () => { expandedInput!.props.onChangeText("Full details here."); });

    const saveExpandedBtn = findPressable(tree.root, "Save Expanded Description");
    await act(async () => { saveExpandedBtn!.props.onPress(); });

    const [, searchUpdater] = mockSetQueriesData.mock.calls[1] as [
      unknown,
      (old: SearchInventoryResponse | undefined) => SearchInventoryResponse | undefined,
    ];
    expect(typeof searchUpdater).toBe("function");

    const fakeSearchOld: SearchInventoryResponse = {
      results: [
        { item: { ...item } as InventoryItem, score: 1 },
        { item: { id: 99, catalog: "OTHER" } as unknown as InventoryItem, score: 0.5 },
      ],
      sizeUnknownResults: [
        { item: { ...item } as InventoryItem, score: 0.8 },
      ],
    } as unknown as SearchInventoryResponse;

    const patched = searchUpdater(fakeSearchOld) as SearchInventoryResponse;

    const r = patched.results.find(x => x.item.id === 42)!;
    expect(r.item.expandedDescription).toBe("Full details here.");

    const su = patched.sizeUnknownResults?.find(x => x.item.id === 42)!;
    expect(su.item.expandedDescription).toBe("Full details here.");

    // Unrelated item untouched.
    expect(patched.results.find(x => x.item.id === 99)!.item.expandedDescription).toBeUndefined();
  });

  it("calls invalidateQueries for [\"searchInventory\"] after save", async () => {
    const item = makeItem();

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const expandedInput = findTextInput(tree.root, "No expanded description yet\u2026");
    await act(async () => { expandedInput!.props.onChangeText("Full details here."); });

    const saveExpandedBtn = findPressable(tree.root, "Save Expanded Description");
    await act(async () => { saveExpandedBtn!.props.onPress(); });

    const searchInvalidateCalls = (mockInvalidateQueries.mock.calls as Array<[{ queryKey?: unknown[] }]>)
      .filter(([arg]) => Array.isArray(arg.queryKey) && arg.queryKey[0] === "searchInventory");

    expect(searchInvalidateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("list-cache updater returns old unchanged when called with undefined", async () => {
    const item = makeItem();

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const expandedInput = findTextInput(tree.root, "No expanded description yet\u2026");
    await act(async () => { expandedInput!.props.onChangeText("Full details here."); });

    const saveExpandedBtn = findPressable(tree.root, "Save Expanded Description");
    await act(async () => { saveExpandedBtn!.props.onPress(); });

    const [, listUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];

    expect(listUpdater(undefined)).toBeUndefined();
  });

  it("does NOT call setQueriesData when the PATCH fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: jest.fn().mockResolvedValue({ error: "Server error" }),
    });

    const item = makeItem();

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const expandedInput = findTextInput(tree.root, "No expanded description yet\u2026");
    await act(async () => { expandedInput!.props.onChangeText("Full details here."); });

    const saveExpandedBtn = findPressable(tree.root, "Save Expanded Description");
    await act(async () => { saveExpandedBtn!.props.onPress(); });

    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });
});

// =============================================================================
// B. handleClearExpandedDesc — synchronous cache patches + invalidation
// =============================================================================

describe("PartDetailsEditor – handleClearExpandedDesc cache patch", () => {
  it("calls setQueriesData twice (list + search) after clearing", async () => {
    const item = makeItem({ expandedDescription: "Existing long text" } as Partial<InventoryItem>);

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const clearBtn = findPressableByA11yLabel(tree.root, "Clear expanded description");
    expect(clearBtn).not.toBeNull();
    await act(async () => { clearBtn!.props.onPress(); });

    expect(mockSetQueriesData).toHaveBeenCalledTimes(2);
  });

  it("list-cache updater sets expandedDescription: null for the target item", async () => {
    const item = makeItem({ expandedDescription: "Existing long text" } as Partial<InventoryItem>);

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const clearBtn = findPressableByA11yLabel(tree.root, "Clear expanded description");
    await act(async () => { clearBtn!.props.onPress(); });

    const [, listUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];
    expect(typeof listUpdater).toBe("function");

    const fakeOld: InventoryListResponse = {
      items: [
        { ...item, expandedDescription: "Existing long text" } as unknown as InventoryItem,
        { id: 99, catalog: "OTHER", expandedDescription: "Keep this" } as unknown as InventoryItem,
      ],
      total: 2,
    } as unknown as InventoryListResponse;

    const patched = listUpdater(fakeOld) as InventoryListResponse;

    expect(patched.items.find(i => i.id === 42)!.expandedDescription).toBeNull();
    // Unrelated item untouched.
    expect(patched.items.find(i => i.id === 99)!.expandedDescription).toBe("Keep this");
  });

  it("search-cache updater sets expandedDescription: null in results and sizeUnknownResults", async () => {
    const item = makeItem({ expandedDescription: "Existing long text" } as Partial<InventoryItem>);

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const clearBtn = findPressableByA11yLabel(tree.root, "Clear expanded description");
    await act(async () => { clearBtn!.props.onPress(); });

    const [, searchUpdater] = mockSetQueriesData.mock.calls[1] as [
      unknown,
      (old: SearchInventoryResponse | undefined) => SearchInventoryResponse | undefined,
    ];
    expect(typeof searchUpdater).toBe("function");

    const fakeSearchOld: SearchInventoryResponse = {
      results: [
        { item: { ...item, expandedDescription: "Existing long text" } as unknown as InventoryItem, score: 1 },
      ],
      sizeUnknownResults: [
        { item: { ...item, expandedDescription: "Existing long text" } as unknown as InventoryItem, score: 0.8 },
      ],
    } as unknown as SearchInventoryResponse;

    const patched = searchUpdater(fakeSearchOld) as SearchInventoryResponse;

    expect(patched.results.find(x => x.item.id === 42)!.item.expandedDescription).toBeNull();
    expect(patched.sizeUnknownResults?.find(x => x.item.id === 42)!.item.expandedDescription).toBeNull();
  });

  it("calls invalidateQueries for [\"searchInventory\"] after clearing", async () => {
    const item = makeItem({ expandedDescription: "Existing long text" } as Partial<InventoryItem>);

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const clearBtn = findPressableByA11yLabel(tree.root, "Clear expanded description");
    await act(async () => { clearBtn!.props.onPress(); });

    const searchInvalidateCalls = (mockInvalidateQueries.mock.calls as Array<[{ queryKey?: unknown[] }]>)
      .filter(([arg]) => Array.isArray(arg.queryKey) && arg.queryKey[0] === "searchInventory");

    expect(searchInvalidateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT call setQueriesData when the clear PATCH fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: jest.fn().mockResolvedValue({ error: "Server error" }),
    });

    const item = makeItem({ expandedDescription: "Existing long text" } as Partial<InventoryItem>);

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const clearBtn = findPressableByA11yLabel(tree.root, "Clear expanded description");
    await act(async () => { clearBtn!.props.onPress(); });

    expect(mockSetQueriesData).not.toHaveBeenCalled();
  });
});

// =============================================================================
// C. patchItem — thumbnailUrl cleared on photo save (handleSave)
// =============================================================================

describe("PartDetailsEditor – patchItem thumbnailUrl cleared on photo save", () => {
  it("list-cache updater sets thumbnailUrl: null when slot-1 photo is saved", async () => {
    // fetch: photo PATCH returns a new imageUrl; all other ops can succeed too.
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ imageUrl: "https://cdn.example.com/new.jpg" }),
    });

    const item = makeItem({
      imageUrl:    "https://cdn.example.com/old.jpg",
      thumbnailUrl: "https://cdn.example.com/old-thumb.jpg",
    } as Partial<InventoryItem>);

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    // Select a photo via the mocked PartPhotoPicker (slot 1).
    const photoPicker = findPressableByTestID(tree.root, "photo-picker-1");
    expect(photoPicker).not.toBeNull();
    await act(async () => { photoPicker!.props.onPress(); });

    // Save.
    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    // At least one setQueriesData call must have occurred.
    expect(mockSetQueriesData).toHaveBeenCalled();

    // Find the list-cache updater (first call targeting inventory-list predicate).
    const listCall = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];
    const listUpdater = listCall[1];
    expect(typeof listUpdater).toBe("function");

    const fakeOld: InventoryListResponse = {
      items: [
        {
          ...item,
          imageUrl:    "https://cdn.example.com/old.jpg",
          thumbnailUrl: "https://cdn.example.com/old-thumb.jpg",
        } as unknown as InventoryItem,
      ],
      total: 1,
    } as unknown as InventoryListResponse;

    const patched = listUpdater(fakeOld) as InventoryListResponse;
    const patchedItem = patched.items.find(i => i.id === 42)!;

    // imageUrl must be updated to the server-returned value.
    expect(patchedItem.imageUrl).toBe("https://cdn.example.com/new.jpg");
    // thumbnailUrl must be nulled so ResultCard falls back to the new imageUrl.
    expect(patchedItem.thumbnailUrl).toBeNull();
  });

  it("list-cache updater sets thumbnailUrl2: null when slot-2 photo is saved", async () => {
    // The slot-2 PATCH endpoint returns { imageUrl2: "..." }, not { imageUrl: "..." }.
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ imageUrl2: "https://cdn.example.com/new2.jpg" }),
    });

    const item = makeItem({
      imageUrl2:    "https://cdn.example.com/old2.jpg",
      thumbnailUrl2: "https://cdn.example.com/old2-thumb.jpg",
    } as Partial<InventoryItem>);

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    // Select a photo via the mocked PartPhotoPicker (slot 2).
    const photoPicker2 = findPressableByTestID(tree.root, "photo-picker-2");
    expect(photoPicker2).not.toBeNull();
    await act(async () => { photoPicker2!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockSetQueriesData).toHaveBeenCalled();

    const listCall = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];
    const listUpdater = listCall[1];

    const fakeOld: InventoryListResponse = {
      items: [
        {
          ...item,
          imageUrl2:    "https://cdn.example.com/old2.jpg",
          thumbnailUrl2: "https://cdn.example.com/old2-thumb.jpg",
        } as unknown as InventoryItem,
      ],
      total: 1,
    } as unknown as InventoryListResponse;

    const patched = listUpdater(fakeOld) as InventoryListResponse;
    const patchedItem = patched.items.find(i => i.id === 42)!;

    expect(patchedItem.imageUrl2).toBe("https://cdn.example.com/new2.jpg");
    expect(patchedItem.thumbnailUrl2).toBeNull();
  });

  it("leaves thumbnailUrl intact on unrelated items in the same cache page", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ imageUrl: "https://cdn.example.com/new.jpg" }),
    });

    const item = makeItem({
      imageUrl:    "https://cdn.example.com/old.jpg",
      thumbnailUrl: "https://cdn.example.com/old-thumb.jpg",
    } as Partial<InventoryItem>);

    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />,
    );
    activeTree = tree;

    const photoPicker = findPressableByTestID(tree.root, "photo-picker-1");
    await act(async () => { photoPicker!.props.onPress(); });

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    const [, listUpdater] = mockSetQueriesData.mock.calls[0] as [
      unknown,
      (old: InventoryListResponse | undefined) => InventoryListResponse | undefined,
    ];

    const otherThumbnail = "https://cdn.example.com/other-thumb.jpg";
    const fakeOld: InventoryListResponse = {
      items: [
        { ...item } as unknown as InventoryItem,
        {
          id:          99,
          catalog:     "OTHER",
          imageUrl:    "https://cdn.example.com/other.jpg",
          thumbnailUrl: otherThumbnail,
        } as unknown as InventoryItem,
      ],
      total: 2,
    } as unknown as InventoryListResponse;

    const patched = listUpdater(fakeOld) as InventoryListResponse;

    // Unrelated item's thumbnailUrl must be preserved.
    expect(patched.items.find(i => i.id === 99)!.thumbnailUrl).toBe(otherThumbnail);
  });
});
