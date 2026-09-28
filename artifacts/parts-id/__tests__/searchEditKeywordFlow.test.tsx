/**
 * Client-flow confirmation for the admin Search → Edit Part multi-field path.
 *
 * This deliberately mounts the real SearchScreen and EditItemScreen. The
 * The production ResultCard is mounted so this covers the real display and
 * edit callback boundary rather than a simplified card substitute.
 */

/* eslint-disable import/first, simple-import-sort/imports */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render, waitFor, type RenderResult } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InventoryItem, SearchInventoryResponse } from "@workspace/api-client-react";
import type { TestInstance } from "test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";

type SearchData = SearchInventoryResponse;
type SearchMutationCallbacks = {
  onSuccess?: (data: SearchData) => void;
  onError?: (error: unknown) => void;
};
type CapturedSearchMutation = {
  variables: unknown;
  callbacks?: SearchMutationCallbacks;
};
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockKeywordsMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockBinsMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockBarcodesMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockCaptureSearchMutations = { current: false };
const mockCapturedSearchMutations: Array<CapturedSearchMutation> = [];
const mockFetchWithAuth = jest.fn();
const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: jest.fn().mockResolvedValue({}),
});
(global as unknown as { fetch: unknown }).fetch = mockFetch;

let selectedItem: InventoryItem | null = null;
let searchResponse: SearchData | undefined;
let searchTimeoutSpy: jest.SpyInstance | null = null;

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
    useSearchInventory: (...args: Array<unknown>) => {
      const mutation = actual.useSearchInventory(
        ...(args as Parameters<typeof actual.useSearchInventory>),
      );
      if (!mockCaptureSearchMutations.current) return mutation;
      return {
        ...mutation,
        mutate: ((variables: unknown, options?: SearchMutationCallbacks) => {
          mockCapturedSearchMutations.push(
            options ? { variables, callbacks: options } : { variables },
          );
        }) as typeof mutation.mutate,
      };
    },
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
  SearchedAsRow: (props: { terms: Array<string>; interpretation: string }) => {
    const R = require("react");
    return R.createElement(
      "mock-ai-translation",
      null,
      R.createElement("Text", null, [...props.terms, props.interpretation].join(" ")),
    );
  },
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
  fetchWithAuth: (...args: Array<unknown>) => mockFetchWithAuth(...args),
}));
jest.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
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
jest.mock("@/contexts/UserHistoryContext", () => {
  const value = {
    history: { queryHistory: [], viewedHistory: [], scanHistory: [] },
    status: "ready",
    recordQuery: jest.fn().mockResolvedValue(undefined),
    clearQueries: jest.fn().mockResolvedValue(undefined),
    recordViewed: jest.fn().mockResolvedValue(undefined),
    clearViewed: jest.fn().mockResolvedValue(undefined),
    recordScan: jest.fn().mockResolvedValue(undefined),
    clearScans: jest.fn().mockResolvedValue(undefined),
  };
  return { useUserHistory: () => value };
});
jest.mock("@/utils/searchResetEvent", () => ({
  searchResetEvent: { subscribe: jest.fn(() => jest.fn()), emit: jest.fn() },
}));
jest.mock("@/utils/translateQuery", () => ({
  ...jest.requireActual("@/utils/translateQuery"),
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
const mockStorageGetItem = AsyncStorage.getItem as jest.Mock<Promise<string | null>, [string]>;
const mockStorageSetItem = AsyncStorage.setItem as jest.Mock<Promise<void>, [string, string]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    catalog: "PART-X",
    description: "Electrical relay",
    vendor: "ACME",
    orderPurchase: 0,
    orderQuantity: 0,
    totalOpOq: 0,
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

function findTextInputs(root: Inst, placeholder: string): Array<Inst> {
  return root
    .queryAll((node: TestInstance) => (node.type as string) === "rn-textinput", { includeSelf: true })
    .filter((node: Inst) => node.props.placeholder === placeholder);
}

function findPressable(root: Inst, text: string): Inst | null {
  return (
    root
      .queryAll(
        (node: TestInstance) =>
          typeof node.props.onPress === "function" &&
          (instText(node).includes(text) ||
            (text === "Edit Part" && String(node.props.accessibilityLabel ?? "").startsWith("Edit "))),
        { includeSelf: true },
      )
      .find((node: Inst) => true) ?? null
  );
}

function cardText(root: Inst, catalog: string): string {
  const card = root
    .queryAll((node: TestInstance) =>
      typeof node.props.testID === "string" && node.props.testID.startsWith("result-card-"),
      { includeSelf: true },
    )
    .find((node: Inst) => instText(node).includes(catalog));
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

let searchTree: RenderResult | null = null;
let editTree: RenderResult | null = null;
let queryClient: QueryClient;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  mockCaptureSearchMutations.current = false;
  mockCapturedSearchMutations.length = 0;
  mockStorageGetItem.mockReset().mockResolvedValue(null);
  mockStorageSetItem.mockReset().mockResolvedValue(undefined);
  mockFetchWithAuth.mockReset().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({}),
  });
  const item = makeItem();
  const other = makeItem({
    id: 99,
    catalog: "OTHER-PART",
    description: "Untouched contactor",
    orderPurchase: 1,
    orderQuantity: 2,
    totalOpOq: 3,
    binLocations: ["Z9-99"],
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
  searchResponse = undefined;
  selectedItem = null;
  queryClient.clear();
  searchTimeoutSpy?.mockRestore();
  searchTimeoutSpy = null;
  mockCaptureSearchMutations.current = false;
  mockCapturedSearchMutations.length = 0;
  mockStorageGetItem.mockReset().mockResolvedValue(null);
  mockStorageSetItem.mockReset().mockResolvedValue(undefined);
  const lifecycleWarnings = consoleErrorSpy.mock.calls.filter(([message]) =>
    /overlapping act\(\) calls|not wrapped in act\(\)/i.test(String(message)),
  );
  consoleErrorSpy.mockRestore();
  expect(lifecycleWarnings).toEqual([]);
});

describe("Search → Edit Part multi-field flow", () => {
  it("keeps the newest same-query search when older network, timeout, offline, AI, and cache work finishes last", async () => {
    const storedValues: Record<string, string> = {};
    let holdQueryCacheRead = true;
    const heldQueryCacheRead = deferred<string | null>();
    const queryCacheReadStarted = deferred<void>();
    mockStorageGetItem.mockImplementation((key) => {
      if (key === "query_cache" && holdQueryCacheRead) {
        holdQueryCacheRead = false;
        queryCacheReadStarted.resolve(undefined);
        return heldQueryCacheRead.promise;
      }
      return Promise.resolve(storedValues[key] ?? null);
    });
    mockStorageSetItem.mockImplementation(async (key, value) => {
      storedValues[key] = value;
    });

    const aiResponses: Array<ReturnType<typeof deferred<Response>>> = [];
    mockFetchWithAuth.mockImplementation(() => {
      const response = deferred<Response>();
      aiResponses.push(response);
      return response.promise;
    });

    const timeoutCallbacks: Array<() => void> = [];
    const realSetTimeout = global.setTimeout;
    searchTimeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(((
      callback: (...args: Array<unknown>) => void,
      delay?: number,
      ...args: Array<unknown>
    ) => {
      if (delay === 8_000) {
        timeoutCallbacks.push(() => callback(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof global.setTimeout);

    mockCaptureSearchMutations.current = true;
    searchTree = await render(
      <QueryClientProvider client={queryClient}>
        <SearchScreen />
      </QueryClientProvider>,
    );

    let searchInput = findHost(searchTree.root!, "keyword-input");
    let searchButton = findPressable(searchTree.root!, "Search");
    expect(searchInput).not.toBeNull();
    expect(searchButton).not.toBeNull();
    await fireEvent.changeText(searchInput!, "same query");
    await fireEvent.press(searchButton!);
    expect(mockCapturedSearchMutations).toHaveLength(1);

    const olderMutation = mockCapturedSearchMutations[0]!;
    await act(async () => {
      olderMutation.callbacks?.onError?.(new Error("older search failed"));
    });
    await queryCacheReadStarted.promise;

    searchInput = findHost(searchTree.root!, "keyword-input");
    searchButton = findPressable(searchTree.root!, "Search");
    await fireEvent.changeText(searchInput!, "same query");
    await fireEvent.press(searchButton!);

    expect(mockCapturedSearchMutations).toHaveLength(2);
    expect(mockCapturedSearchMutations[1]!.variables).toEqual(olderMutation.variables);
    expect(aiResponses).toHaveLength(2);
    expect(timeoutCallbacks).toHaveLength(2);

    const newestItems = [
      makeItem({ id: 201, catalog: "NEWEST-RELAY", description: "Current relay" }),
      makeItem({ id: 202, catalog: "NEWEST-CONTACTOR", description: "Current contactor" }),
    ];
    const newestResponse = {
      results: newestItems.map((item) => ({
        item,
        confidence: 0.98,
        matchReason: "keyword",
        seriesLabel: null,
        variants: [],
      })),
      sizeUnknownResults: [],
      belowThreshold: 4,
      dimensionCounts: { length: { "10": 2 } },
    } as unknown as SearchData;
    const olderResponse = {
      results: [{
        item: makeItem({ id: 101, catalog: "OLDER-RESULT", description: "Stale relay" }),
        confidence: 0.98,
        matchReason: "keyword",
        seriesLabel: null,
        variants: [],
      }],
      sizeUnknownResults: [],
      belowThreshold: 99,
      dimensionCounts: { length: { "99": 1 } },
    } as unknown as SearchData;

    await act(async () => {
      mockCapturedSearchMutations[1]!.callbacks?.onSuccess?.(newestResponse);
    });
    await waitFor(() => {
      expect(cardText(searchTree!.root!, "NEWEST-RELAY")).toContain("Current relay");
      expect(cardText(searchTree!.root!, "NEWEST-CONTACTOR")).toContain("Current contactor");
    });

    await act(async () => {
      aiResponses[1]!.resolve(makeJsonResponse({
        appliedTranslation: true,
        translatedTerms: ["newest terms"],
        interpretation: "newest interpretation",
      }));
    });
    await waitFor(() => {
      expect(instText(searchTree!.root!)).toContain("newest interpretation");
    });

    await act(async () => {
      olderMutation.callbacks?.onSuccess?.(olderResponse);
      timeoutCallbacks[0]!();
      aiResponses[0]!.resolve(makeJsonResponse({
        appliedTranslation: true,
        translatedTerms: ["older terms"],
        interpretation: "older interpretation",
      }));
    });
    searchTimeoutSpy?.mockRestore();
    searchTimeoutSpy = null;
    heldQueryCacheRead.resolve(null);
    await waitFor(() => {
      expect(storedValues["query_cache"]).toBeDefined();
      const cache = JSON.parse(storedValues["query_cache"]!) as Record<
        string,
        { results: Array<{ item: { id: number } }> }
      >;
      expect(cache["keyword-flow"]?.results.map((result) => result.item.id)).toEqual([201, 202]);
    });

    const visibleText = instText(searchTree.root!);
    expect(cardText(searchTree.root!, "OLDER-RESULT")).toBe("");
    expect(visibleText).toMatch(/2\s+matches found/);
    expect(visibleText).toContain("4 more matches available at 30%");
    expect(visibleText).toContain("newest interpretation");
    expect(visibleText).not.toContain("older interpretation");
    expect(visibleText).not.toContain("Internet Offline—using local search");
    expect(visibleText).not.toContain("Search timed out — showing cached results");
    expect(queryClient.getQueryData(["searchInventory", "active"])).toMatchObject({
      results: newestResponse.results,
      belowThreshold: 4,
      dimensionCounts: { length: { "10": 2 } },
    });
  });

  it("updates the selected result's part information immediately after one save", async () => {
    searchTree = await render(
      <QueryClientProvider client={queryClient}>
        <SearchScreen />
      </QueryClientProvider>,
    );

    const searchInput = findHost(searchTree.root!, "keyword-input");
    expect(searchInput).not.toBeNull();
    await fireEvent.changeText(searchInput!, "old keyword");

    const searchButton = findPressable(searchTree.root!, "Search");
    expect(searchButton).not.toBeNull();
    await fireEvent.press(searchButton!);
    await waitFor(() => {
      expect(cardText(searchTree!.root!, "PART-X")).toContain("Electrical relay");
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/inventory/search"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"keywords":"OLD KEYWORD"'),
      }),
    );
    expect(cardText(searchTree.root!, "PART-X")).toContain("Electrical relay");
    expect(cardText(searchTree.root!, "PART-X")).toContain("PART-X");
    expect(cardText(searchTree.root!, "OTHER-PART")).toContain("Untouched contactor");

    const editButton = findPressable(searchTree.root!, "Edit Part");
    expect(editButton).not.toBeNull();
    await fireEvent.press(editButton!);

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
    await fireEvent.press(oldKeywordChip!);

    const descriptionInput = findTextInput(editTree.root!, "Brief description of the part…");
    expect(descriptionInput).not.toBeNull();
    await fireEvent.changeText(descriptionInput!, "  Updated relay  ");

    const binInput = findTextInput(editTree.root!, "e.g. A1-04");
    expect(binInput).not.toBeNull();
    await fireEvent.changeText(binInput!, "  B2-07  ");

    const keywordInput = findTextInput(editTree.root!, "Type keyword and press Add…");
    expect(keywordInput).not.toBeNull();
    await fireEvent.changeText(keywordInput!, " Replacement Keyword ");

    const opoqInputs = findTextInputs(editTree.root!, "0");
    expect(opoqInputs).toHaveLength(2);
    await fireEvent.changeText(opoqInputs[0]!, "7");
    await fireEvent.changeText(opoqInputs[1]!, "8");

    const dimensionInputs = findTextInputs(editTree.root!, "–");
    expect(dimensionInputs).toHaveLength(4);
    await fireEvent.changeText(dimensionInputs[0]!, "12.34");
    await fireEvent.changeText(dimensionInputs[1]!, "4.56");
    await fireEvent.changeText(dimensionInputs[2]!, "7");

    const saveButton = findPressable(editTree.root!, "Save Details");
    expect(saveButton).not.toBeNull();
    await fireEvent.press(saveButton!);
    await waitFor(() => {
      expect(mockKeywordsMutateAsync).toHaveBeenCalledTimes(1);
      expect(cardText(searchTree!.root!, "PART-X")).toContain("Total OP/OQ15");
    });

    expect(mockKeywordsMutateAsync).toHaveBeenCalledWith({
      id: 42,
      data: { keywords: ["replacement keyword"] },
    });
    expect(mockBinsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockBinsMutateAsync).toHaveBeenCalledWith({
      id: 42,
      data: { binLocations: ["A1-04", "B2-07"] },
    });
    expect(mockBarcodesMutateAsync).not.toHaveBeenCalled();

    const requestBodies = new Map(
      mockFetch.mock.calls
        .filter(([url]) => String(url).includes("/api/inventory/42/"))
        .map(([url, init]) => [
          String(url).replace("http://localhost:8080/api", ""),
          JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
        ]),
    );
    expect(requestBodies.get("/inventory/42/description")).toEqual({ description: "Updated relay" });
    expect(requestBodies.get("/inventory/42/order")).toEqual({ orderPurchase: 7, orderQuantity: 8 });
    expect(requestBodies.get("/inventory/42/dimensions")).toEqual({
      length: 12.3,
      width: 4.6,
      height: 7,
      diameter: null,
    });
    expect(requestBodies.size).toBe(3);

    // The production cache updater has now fed the patched result back into
    // the mounted search screen. No manual re-search is involved.
    const updatedSelectedCard = cardText(searchTree.root!, "PART-X");
    expect(updatedSelectedCard).toContain("Updated relay");
    expect(updatedSelectedCard).toContain("B2-07");
    expect(updatedSelectedCard).toContain("Total OP/OQ15");
    expect(updatedSelectedCard).toContain("12.3 × 4.6 × 7 mm");
    const untouchedCard = cardText(searchTree.root!, "OTHER-PART");
    expect(untouchedCard).toContain("Untouched contactor");
    expect(untouchedCard).toContain("Z9-99");
    expect(untouchedCard).toContain("Total OP/OQ3");
    expect(untouchedCard).not.toContain("Updated relay");
    expect(untouchedCard).not.toContain("B2-07");
    expect(untouchedCard).not.toContain("Total OP/OQ15");

    expect(mockBack).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mockBack).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps successful fields visible while a rejected field stays unsaved", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/inventory/42/description")) {
        return new Response(JSON.stringify({ error: "description rejected" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(searchResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    searchTree = await render(
      <QueryClientProvider client={queryClient}>
        <SearchScreen />
      </QueryClientProvider>,
    );
    const searchInput = findHost(searchTree.root!, "keyword-input");
    await fireEvent.changeText(searchInput!, "old keyword");
    const searchButton = findPressable(searchTree.root!, "Search");
    await fireEvent.press(searchButton!);
    await waitFor(() => {
      expect(cardText(searchTree!.root!, "PART-X")).toContain("Electrical relay");
    });

    const editButton = findPressable(searchTree.root!, "Edit Part");
    await fireEvent.press(editButton!);
    editTree = await render(
      <QueryClientProvider client={queryClient}>
        <EditItemScreen />
      </QueryClientProvider>,
    );

    const descriptionInput = findTextInput(editTree.root!, "Brief description of the part…");
    await fireEvent.changeText(descriptionInput!, "Rejected description");
    const opoqInputs = findTextInputs(editTree.root!, "0");
    await fireEvent.changeText(opoqInputs[0]!, "7");
    await fireEvent.changeText(opoqInputs[1]!, "8");

    const saveButton = findPressable(editTree.root!, "Save Details");
    await fireEvent.press(saveButton!);
    await waitFor(() => {
      expect(instText(editTree!.root!)).toContain("Description failed");
      expect(cardText(searchTree!.root!, "PART-X")).toContain("Total OP/OQ15");
    });

    expect(instText(editTree.root!)).toContain("Description failed");
    const selectedCard = cardText(searchTree.root!, "PART-X");
    expect(selectedCard).toContain("Electrical relay");
    expect(selectedCard).not.toContain("Rejected description");
    expect(selectedCard).toContain("Total OP/OQ15");
    expect(cardText(searchTree.root!, "OTHER-PART")).toContain("Untouched contactor");
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("saves changed OP and OQ values as an admin without an MFA-specific rejection, updating Total OP/OQ", async () => {
    searchTree = await render(
      <QueryClientProvider client={queryClient}>
        <SearchScreen />
      </QueryClientProvider>,
    );
    const searchInput = findHost(searchTree.root!, "keyword-input");
    await fireEvent.changeText(searchInput!, "old keyword");
    const searchButton = findPressable(searchTree.root!, "Search");
    await fireEvent.press(searchButton!);
    await waitFor(() => {
      expect(cardText(searchTree!.root!, "PART-X")).toContain("Electrical relay");
    });

    const editButton = findPressable(searchTree.root!, "Edit Part");
    await fireEvent.press(editButton!);
    editTree = await render(
      <QueryClientProvider client={queryClient}>
        <EditItemScreen />
      </QueryClientProvider>,
    );

    const opoqInputs = findTextInputs(editTree.root!, "0");
    expect(opoqInputs).toHaveLength(2);
    await fireEvent.changeText(opoqInputs[0]!, "9");
    await fireEvent.changeText(opoqInputs[1]!, "6");

    const saveButton = findPressable(editTree.root!, "Save Details");
    await fireEvent.press(saveButton!);
    await waitFor(() => {
      expect(cardText(searchTree!.root!, "PART-X")).toContain("Total OP/OQ15");
    });

    // Only the /order endpoint receives an OP/OQ payload, and it never carries
    // an MFA-specific rejection — the write must succeed on the first attempt.
    const orderCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/inventory/42/order"));
    expect(orderCall).toBeDefined();
    expect(JSON.parse(String((orderCall![1] as RequestInit).body))).toEqual({
      orderPurchase: 9,
      orderQuantity: 6,
    });

    const updatedCard = cardText(searchTree.root!, "PART-X");
    expect(updatedCard).toContain("Total OP/OQ15");
    await waitFor(() => {
      expect(mockBack).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the prior OP/OQ values and Total OP/OQ visible when the order save fails", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/inventory/42/order")) {
        return new Response(JSON.stringify({ error: "order update rejected" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(searchResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    searchTree = await render(
      <QueryClientProvider client={queryClient}>
        <SearchScreen />
      </QueryClientProvider>,
    );
    const searchInput = findHost(searchTree.root!, "keyword-input");
    await fireEvent.changeText(searchInput!, "old keyword");
    const searchButton = findPressable(searchTree.root!, "Search");
    await fireEvent.press(searchButton!);
    await waitFor(() => {
      expect(cardText(searchTree!.root!, "PART-X")).toContain("Electrical relay");
    });

    const editButton = findPressable(searchTree.root!, "Edit Part");
    await fireEvent.press(editButton!);
    editTree = await render(
      <QueryClientProvider client={queryClient}>
        <EditItemScreen />
      </QueryClientProvider>,
    );

    const opoqInputs = findTextInputs(editTree.root!, "0");
    await fireEvent.changeText(opoqInputs[0]!, "9");
    await fireEvent.changeText(opoqInputs[1]!, "6");

    const saveButton = findPressable(editTree.root!, "Save Details");
    await fireEvent.press(saveButton!);
    await waitFor(() => {
      expect(instText(editTree!.root!)).toContain("OP/OQ failed");
    });

    // The failed field's inputs revert to the item's prior saved values, and
    // the search card keeps showing the pre-edit total rather than a value
    // computed from the rejected input.
    const revertedOpoqInputs = findTextInputs(editTree.root!, "0");
    expect(revertedOpoqInputs).toHaveLength(2);
    const selectedCard = cardText(searchTree.root!, "PART-X");
    expect(selectedCard).toContain("Total OP/OQ0");
    expect(selectedCard).not.toContain("Total OP/OQ15");
    expect(cardText(searchTree.root!, "OTHER-PART")).toContain("Total OP/OQ3");
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("shows invalid OP/OQ values without sending a write or changing cached totals", async () => {
    selectedItem = searchResponse!.results[0]!.item;
    editTree = await render(
      <QueryClientProvider client={queryClient}>
        <EditItemScreen />
      </QueryClientProvider>,
    );

    const opoqInputs = findTextInputs(editTree.root!, "0");
    expect(opoqInputs).toHaveLength(2);
    await fireEvent.changeText(opoqInputs[0]!, "-1");
    await fireEvent.changeText(opoqInputs[1]!, "2.5");

    const saveButton = findPressable(editTree.root!, "Save Details");
    await fireEvent.press(saveButton!);
    await waitFor(() => {
      expect(instText(editTree!.root!)).toContain("OP and OQ must be non-negative whole numbers.");
    });

    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes("/inventory/42/order")),
    ).toBe(false);
    expect(mockBack).not.toHaveBeenCalled();
  });
});