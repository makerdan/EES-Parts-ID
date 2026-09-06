/**
 * Client-flow confirmation for the admin Search → Edit Part keyword path.
 *
 * This deliberately mounts the real SearchScreen and EditItemScreen. The
 * search result card is a small deterministic test double so the test can
 * capture the edit callback while keeping the assertion focused on the
 * screen-to-screen and cache-collaborator contracts.
 */

/* eslint-disable import/first, simple-import-sort/imports */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render, type RenderResult } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InventoryItem, SearchInventoryResponse } from "@workspace/api-client-react";
import type { TestInstance } from "test-renderer";

type SearchData = SearchInventoryResponse;
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockKeywordsMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockBinsMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockBarcodesMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: jest.fn().mockResolvedValue({}),
});
(global as unknown as { fetch: unknown }).fetch = mockFetch;

let selectedItem: InventoryItem | null = null;
let searchResponse: SearchData | undefined;

jest.mock("expo-router", () => ({
  router: {
    push: (...args: Array<unknown>) => {
      mockPush(...args);
      const route = args[0] as { params?: { item?: string } };
      selectedItem = route.params?.item ? JSON.parse(route.params.item) as InventoryItem : null;
    },
    back: (...args: Array<unknown>) => mockBack(...args),
  },
  useRouter: jest.fn(() => ({ push: mockPush, back: mockBack })),
  useLocalSearchParams: jest.fn(() => ({
    item: selectedItem ? JSON.stringify(selectedItem) : undefined,
    section: undefined,
  })),
  useFocusEffect: jest.fn(),
  useNavigation: jest.fn(() => ({
    addListener: jest.fn(() => jest.fn()),
    dispatch: jest.fn(),
  })),
}));

jest.mock("@workspace/api-client-react", () => {
  const actual = jest.requireActual("@workspace/api-client-react") as typeof import("@workspace/api-client-react");
  return {
    ...actual,
  useUpdateItemKeywords: jest.fn(() => ({
    mutateAsync: (...args: Array<unknown>) => mockKeywordsMutateAsync(...args),
  })),
  useUpdateItemBins: jest.fn(() => ({
    mutateAsync: (...args: Array<unknown>) => mockBinsMutateAsync(...args),
  })),
  useUpdateItemBarcodes: jest.fn(() => ({
    mutateAsync: (...args: Array<unknown>) => mockBarcodesMutateAsync(...args),
  })),
  useAiIdentifyPart: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    reset: jest.fn(),
  })),
  setAuthTokenGetter: jest.fn(),
  setBaseUrl: jest.fn(),
  lookupByBarcode: jest.fn(),
  };
});

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: true }),
  },
  NetInfoStateType: { unknown: "unknown", none: "none", wifi: "wifi", cellular: "cellular" },
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
    multiRemove: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/components/ResultCard", () => {
  const R = require("react");
  return {
    ResultCard: (props: {
      result: { item: InventoryItem };
      onEditItem?: (item: InventoryItem) => void;
    }) =>
      R.createElement(
        "rn-result-card",
        null,
        R.createElement("Text", null, props.result.item.catalog),
        ...(props.result.item.aiKeywords ?? []).map((keyword) =>
          R.createElement("Text", { key: keyword }, keyword),
        ),
        R.createElement(
          "rn-pressable",
          {
            accessibilityLabel: `Edit ${props.result.item.catalog}`,
            onPress: () => props.onEditItem?.(props.result.item),
          },
          R.createElement("Text", null, "Edit Part"),
        ),
      ),
  };
});

jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/PartPhotoPicker", () => ({ PartPhotoPicker: () => null }));
jest.mock("@/components/FilterPanel", () => ({
  FilterPanel: () => null,
  ConfidenceSlider: () => null,
}));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/PartDetailsEditor", () => ({ PartDetailsEditor: () => null }));
jest.mock("@/components/BrowseByAisle", () => ({ BrowseByAisle: () => null }));
jest.mock("@/components/BrowseByCategory", () => ({ BrowseByCategory: () => null }));
jest.mock("@/components/BarcodeScanModal", () => ({ BarcodeScanModal: () => null }));
jest.mock("@/components/BarcodeScreen", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AISearchFallback", () => ({
  AIZeroResultsCard: () => null,
  SearchedAsRow: () => null,
}));
jest.mock("@/components/RecentSearchesPanel", () => ({ RecentSearchesPanel: () => null }));
jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

jest.mock("@/components/KeyboardDoneInput", () => {
  const R = require("react");
  return {
    KeyboardDoneInput: (props: {
      placeholder?: string;
      onChangeText?: (value: string) => void;
      onSubmitEditing?: () => void;
      value?: string;
      [key: string]: unknown;
    }) =>
      R.createElement(
        props.placeholder?.startsWith("Search parts")
          ? "keyword-input"
          : "rn-textinput",
        {
          testID: props.placeholder ?? "",
          placeholder: props.placeholder,
          value: props.value,
          onChangeText: props.onChangeText,
          onSubmitEditing: props.onSubmitEditing,
        },
      ),
  };
});

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());
jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));
jest.mock("@/utils/adminGuard", () => ({
  shouldRedirectNonAdmin: jest.fn(() => false),
}));
jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));
jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) }),
}));
jest.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
}));
jest.mock("lidar-measure", () => ({
  isLiDARSupported: jest.fn(() => false),
}));
jest.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: jest.fn().mockResolvedValue("base64data"),
  cacheDirectory: "/tmp/",
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  downloadAsync: jest.fn().mockResolvedValue({ status: 200, uri: "/tmp/file" }),
}));

jest.mock("@/lib/aisleHierarchy", () => ({
  parseBin: jest.fn().mockReturnValue({ aisle: "01", bay: "02", shelf: "A" }),
}));
jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));
jest.mock("@/utils/storageErrorReporter", () => ({
  reportStorageError: jest.fn(),
  setStorageErrorHandler: jest.fn(),
}));
jest.mock("@/utils/retryAsync", () => ({
  retryAsync: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock("@/utils/queryCacheBound", () => ({
  evictLRU: jest.fn((cache: unknown) => cache),
  QUERY_CACHE_MAX_ENTRIES: 100,
}));
jest.mock("@/utils/offlineBarcode", () => ({
  FUSE_CACHE_KEY: "fuse_cache",
  FUSE_CACHE_SYNCED_AT_KEY: "fuse_synced_at",
  FUSE_SOFT_STALE_MS: Infinity,
  FUSE_SYNC_MAX_AGE_MS: Infinity,
  getFuseCacheSyncedAt: jest.fn().mockResolvedValue(Date.now()),
  parseFuseCacheItems: jest.fn().mockReturnValue([]),
  replaceBarcodeCacheWithServerItems: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/utils/searchHelpers", () => ({
  QUERY_CACHE_KEY: "query_cache",
  buildQueryKey: jest.fn().mockReturnValue("keyword-flow"),
  buildSearchBody: jest.fn().mockReturnValue({ keywords: "OLD KEYWORD", confidenceThreshold: 50 }),
  pruneExpired: jest.fn((cache: unknown) => cache),
  formatStaleCacheWarning: jest.fn().mockReturnValue(""),
  formatRelativeAge: jest.fn().mockReturnValue("1 hour ago"),
  resolveOfflineFallback: jest.fn().mockReturnValue({ results: [], cacheType: null }),
  fetchInventoryPages: jest.fn().mockResolvedValue([]),
  evictItemFromQueryCache: jest.fn((cache: unknown) => ({ pruned: cache, changed: false })),
}));
jest.mock("@/utils/searchHistory", () => ({
  appendQueryHistory: jest.fn().mockResolvedValue(undefined),
  appendViewedHistory: jest.fn().mockResolvedValue(undefined),
  clearQueryHistory: jest.fn().mockResolvedValue(undefined),
  clearViewedHistory: jest.fn().mockResolvedValue(undefined),
  loadQueryHistory: jest.fn().mockResolvedValue([]),
  loadViewedHistory: jest.fn().mockResolvedValue([]),
}));
jest.mock("@/utils/searchResetEvent", () => ({
  searchResetEvent: { subscribe: jest.fn(() => jest.fn()), emit: jest.fn() },
}));
jest.mock("@/utils/translateQuery", () => ({
  runTranslateQuery: jest.fn().mockResolvedValue(null),
}));
jest.mock("fuse.js", () => jest.fn().mockImplementation(() => ({
  search: jest.fn().mockReturnValue([]),
})));

import SearchScreen from "../app/(tabs)/index";
import EditItemScreen from "../app/edit-item";

// jest.config.js maps this module to the stable Jest AppContext mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

type Inst = TestInstance;

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    catalog: "PART-X",
    description: "Electrical relay",
    vendor: "ACME",
    binLocations: ["A1-04"],
    barcodes: [],
    aiKeywords: ["old keyword"],
    imageUrl: null,
    imageUrl2: null,
    dimensions: null,
    ...overrides,
  } as unknown as InventoryItem;
}

function makeSearchData(item: InventoryItem, other: InventoryItem): SearchData {
  return {
    results: [
      { item, confidence: 0.98, matchReason: "keyword", seriesLabel: null, variants: [] },
      { item: other, confidence: 0.72, matchReason: "keyword", seriesLabel: null, variants: [] },
    ],
    sizeUnknownResults: [],
    belowThreshold: 0,
    dimensionCounts: undefined,
  } as unknown as SearchData;
}

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((child) => instText(child as Inst | string)).join("");
}

function findHost(root: Inst, type: string, predicate?: (node: Inst) => boolean): Inst | null {
  return (
    root
      .queryAll((node: TestInstance) => (node.type as string) === type, { includeSelf: true })
      .find((node: Inst) => predicate?.(node) ?? true) ?? null
  );
}

function findTextInput(root: Inst, placeholder: string): Inst | null {
  return findHost(root, "rn-textinput", (node) => node.props.placeholder === placeholder);
}

function findPressable(root: Inst, text: string): Inst | null {
  return findHost(root, "rn-pressable", (node) => instText(node).includes(text));
}

function cardText(root: Inst, catalog: string): string {
  const card = findHost(root, "rn-result-card", (node) => instText(node).includes(catalog));
  return card ? instText(card) : "";
}

function makeAppContext() {
  return {
    settings: {
      textSize: "normal" as const,
      defaultConfidenceThreshold: 50,
      themeMode: "system" as const,
      shelfViewEnabled: true,
      scanSound: true,
      dimensionUnit: "mm" as const,
    },
    updateSetting: jest.fn(),
    logout: jest.fn(),
    clearCache: jest.fn(),
    isLoading: false,
    isAdmin: true,
    adminToken: "test-token",
    registerLogoutHandler: jest.fn(() => () => {}),
    setPendingMapFocus: jest.fn(),
    showToast: jest.fn(),
    setPinnedParts: jest.fn(),
    pendingMeasureSearch: null,
    setPendingMeasureSearch: jest.fn(),
    pendingInventorySearch: null,
    setPendingInventorySearch: jest.fn(),
    textFontScale: 1,
    pinnedParts: [],
  };
}

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

let searchTree: RenderResult | null = null;
let editTree: RenderResult | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  jest.useFakeTimers();
  const item = makeItem();
  const other = makeItem({
    id: 99,
    catalog: "OTHER-PART",
    description: "Untouched contactor",
    aiKeywords: ["untouched"],
  });
  searchResponse = makeSearchData(item, other);
  selectedItem = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  useApp.mockReturnValue(makeAppContext());
  mockPush.mockClear();
  mockBack.mockClear();
  mockKeywordsMutateAsync.mockClear().mockResolvedValue(undefined);
  mockBinsMutateAsync.mockClear().mockResolvedValue(undefined);
  mockBarcodesMutateAsync.mockClear().mockResolvedValue(undefined);
  mockFetch.mockClear().mockResolvedValue(
    new Response(JSON.stringify(searchResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(async () => {
  if (editTree) {
    await editTree.unmount();
    editTree = null;
  }
  if (searchTree) {
    await searchTree.unmount();
    searchTree = null;
  }
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  searchResponse = undefined;
  selectedItem = null;
  queryClient.clear();
});

describe("Search → Edit Part keyword flow", () => {
  it("updates the selected result's part information immediately after saving a keyword", async () => {
    searchTree = await render(
      <QueryClientProvider client={queryClient}>
        <SearchScreen />
      </QueryClientProvider>,
    );

    const searchInput = findHost(searchTree.root!, "keyword-input");
    expect(searchInput).not.toBeNull();
    await act(async () => {
      fireEvent.changeText(searchInput!, "old keyword");
    });

    const searchButton = findPressable(searchTree.root!, "Search");
    expect(searchButton).not.toBeNull();
    await act(async () => {
      fireEvent.press(searchButton!);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/inventory/search"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"keywords":"OLD KEYWORD"'),
      }),
    );
    expect(cardText(searchTree.root!, "PART-X")).toContain("old keyword");
    expect(cardText(searchTree.root!, "PART-X")).toContain("PART-X");
    expect(cardText(searchTree.root!, "OTHER-PART")).toContain("untouched");

    const editButton = findPressable(searchTree.root!, "Edit Part");
    expect(editButton).not.toBeNull();
    await act(async () => {
      fireEvent.press(editButton!);
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushedRoute = mockPush.mock.calls[0]![0] as {
      pathname: string;
      params: { item: string };
    };
    expect(pushedRoute.pathname).toBe("/edit-item");
    expect(JSON.parse(pushedRoute.params.item)).toEqual(searchResponse!.results[0]!.item);
    expect(selectedItem?.id).toBe(42);

    editTree = await render(
      <QueryClientProvider client={queryClient}>
        <EditItemScreen />
      </QueryClientProvider>,
    );
    const oldKeywordChip = findPressable(editTree.root!, "old keyword");
    expect(oldKeywordChip).not.toBeNull();
    await act(async () => {
      fireEvent.press(oldKeywordChip!);
    });

    const keywordInput = findTextInput(editTree.root!, "Type keyword and press Add…");
    expect(keywordInput).not.toBeNull();
    await act(async () => {
      fireEvent.changeText(keywordInput!, "Replacement Keyword");
    });

    const saveButton = findPressable(editTree.root!, "Save Details");
    expect(saveButton).not.toBeNull();
    await act(async () => {
      fireEvent.press(saveButton!);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockKeywordsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockKeywordsMutateAsync).toHaveBeenCalledWith({
      id: 42,
      data: { keywords: ["replacement keyword"] },
    });
    expect(mockBinsMutateAsync).not.toHaveBeenCalled();
    expect(mockBarcodesMutateAsync).not.toHaveBeenCalled();
    // The production cache updater has now fed the patched result back into
    // the mounted search screen. No manual re-search is involved.
    await flushMicrotasks();
    const updatedSelectedCard = cardText(searchTree.root!, "PART-X");
    expect(updatedSelectedCard).toContain("replacement keyword");
    expect(updatedSelectedCard).not.toContain("old keyword");
    expect(cardText(searchTree.root!, "OTHER-PART")).toContain("untouched");

    expect(mockBack).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});