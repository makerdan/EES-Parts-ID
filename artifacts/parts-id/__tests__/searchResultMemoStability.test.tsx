/**
 * @jest-environment node
 *
 * Reference-stability tests for the flatListData memo inside the real
 * SearchScreen component (app/(tabs)/index.tsx lines 1016–1026).
 *
 * Strategy
 * ────────
 * After all modules are imported, we install a spy on the `FlatList` property
 * of the react-native mock object.  TypeScript compiles named imports as
 * property accesses on the require'd module (`react_native_1.FlatList`), so
 * mutating the property AFTER import still intercepts every call made during
 * rendering.  The spy records the `data` prop on each FlatList render so we
 * can assert reference identity across re-renders.
 *
 * Covered scenarios
 * ─────────────────
 * 1. flatListData is the same reference after an unrelated re-render
 *    (tree.update with unchanged search mutation data)
 * 2. flatListData is a NEW reference when searchMutation.data changes
 *    (memo correctly invalidates when its dep changes)
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  router: { navigate: jest.fn(), push: jest.fn() },
  useFocusEffect: jest.fn(),
}));

// ── @workspace/api-client-react ───────────────────────────────────────────────

const mockUseSearchInventory = jest.fn();

jest.mock("@workspace/api-client-react", () => ({
  useSearchInventory:  (...args: unknown[]) => mockUseSearchInventory(...args),
  useAiIdentifyPart:   jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isSuccess: false, isError: false, reset: jest.fn() })),
  setAuthTokenGetter:  jest.fn(),
  setBaseUrl:          jest.fn(),
  lookupByBarcode:     jest.fn(),
}));

// ── @react-native-community/netinfo ───────────────────────────────────────────

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: true }),
  },
  NetInfoStateType: { unknown: "unknown", none: "none", wifi: "wifi", cellular: "cellular" },
}));

// ── @react-native-async-storage/async-storage ─────────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:     jest.fn().mockResolvedValue(null),
  setItem:     jest.fn().mockResolvedValue(undefined),
  removeItem:  jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

// ── fuse.js ───────────────────────────────────────────────────────────────────

jest.mock("fuse.js", () =>
  jest.fn().mockImplementation(() => ({ search: jest.fn().mockReturnValue([]) }))
);

// ── @/hooks/useColors ─────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ── components ────────────────────────────────────────────────────────────────

jest.mock("@/components/ResultCard",          () => ({ ResultCard: () => null }));
jest.mock("@/components/MeasurePartScreen",   () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/FilterPanel",         () => ({ FilterPanel: () => null, ConfidenceSlider: () => null }));
jest.mock("@/components/ReferenceModal",      () => ({ ReferenceModal: () => null }));
jest.mock("@/components/PartDetailsEditor",   () => ({ PartDetailsEditor: () => null }));
jest.mock("@/components/BrowseByAisle",       () => ({ BrowseByAisle: () => null }));
jest.mock("@/components/BrowseByCategory",    () => ({ BrowseByCategory: () => null }));
jest.mock("@/components/BarcodeScanModal",    () => ({ BarcodeScanModal: () => null }));
jest.mock("@/components/BarcodeScreen",       () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AISearchFallback",    () => ({ AIZeroResultsCard: () => null, SearchedAsRow: () => null }));
jest.mock("@/components/KeyboardDoneInput",   () => ({ KeyboardDoneInput: () => null }));
jest.mock("@/components/RecentSearchesPanel", () => ({ RecentSearchesPanel: () => null }));

// ── @expo/vector-icons ────────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ── @/constants/colors ────────────────────────────────────────────────────────

jest.mock("@/constants/colors", () => ({
  __esModule: true,
  default: {
    light: {
      background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
      primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
      mutedForeground: "#64748b", destructive: "#ef4444",
      success: "#22c55e", warning: "#f59e0b",
    },
    dark: {
      background: "#000", foreground: "#fff", card: "#111", border: "#333",
      primary: "#3b82f6", primaryForeground: "#fff", muted: "#1e293b",
      mutedForeground: "#94a3b8", destructive: "#ef4444",
      success: "#22c55e", warning: "#f59e0b",
    },
    radius: 8,
  },
}));

// ── Utility mocks ─────────────────────────────────────────────────────────────

jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));

jest.mock("@/utils/storageErrorReporter", () => ({
  reportStorageError:     jest.fn(),
  setStorageErrorHandler: jest.fn(),
}));

jest.mock("@/utils/retryAsync", () => ({
  retryAsync: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock("@/utils/queryCacheBound", () => ({
  evictLRU:               jest.fn((c: unknown) => c),
  QUERY_CACHE_MAX_ENTRIES: 100,
}));

jest.mock("@/utils/offlineBarcode", () => ({
  FUSE_CACHE_KEY:           "fuse_cache",
  FUSE_CACHE_SYNCED_AT_KEY: "fuse_synced_at",
  getFuseCacheSyncedAt:     jest.fn().mockResolvedValue(Date.now()),
  FUSE_SYNC_MAX_AGE_MS:     Infinity,
  lookupByBarcodeOffline:   jest.fn().mockResolvedValue(null),
}));

jest.mock("@/utils/searchHelpers", () => ({
  QUERY_CACHE_KEY:          "query_cache",
  buildQueryKey:            jest.fn().mockReturnValue("test-key"),
  buildSearchBody:          jest.fn().mockReturnValue({ keywords: "", confidenceThreshold: 50 }),
  pruneExpired:             jest.fn((c: unknown) => c),
  formatStaleCacheWarning:  jest.fn().mockReturnValue(""),
  formatRelativeAge:        jest.fn().mockReturnValue("1 hour ago"),
  resolveOfflineFallback:   jest.fn().mockReturnValue({ results: [], cacheType: null }),
  fetchInventoryPages:      jest.fn().mockResolvedValue([]),
}));

jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));

jest.mock("@/utils/searchHistory", () => ({
  appendQueryHistory:  jest.fn().mockResolvedValue(undefined),
  appendViewedHistory: jest.fn().mockResolvedValue(undefined),
  clearQueryHistory:   jest.fn().mockResolvedValue(undefined),
  clearViewedHistory:  jest.fn().mockResolvedValue(undefined),
  loadQueryHistory:    jest.fn().mockResolvedValue([]),
  loadViewedHistory:   jest.fn().mockResolvedValue([]),
}));

jest.mock("@/utils/searchResetEvent", () => ({
  searchResetEvent: { subscribe: jest.fn(() => jest.fn()), emit: jest.fn() },
}));

jest.mock("@/utils/translateQuery", () => ({
  runTranslateQuery: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/aisleHierarchy", () => ({
  parseBin: jest.fn().mockReturnValue({ aisle: "01", bay: "02", shelf: "A" }),
}));

// ── react-native-reanimated ───────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const makeShared = (v: unknown) => ({ value: v });
  const AnimatedView = ({ children, style }: { children?: React.ReactNode; style?: unknown }) =>
    React.createElement("rn-animated-view", { style }, children);
  const createAnimatedComponent = (C: unknown) => C;
  return {
    __esModule: true,
    useSharedValue:       makeShared,
    useAnimatedStyle:     () => ({}),
    useAnimatedProps:     () => ({}),
    useAnimatedReaction:  () => {},
    withSpring:           (v: unknown) => v,
    withRepeat:           (a: unknown) => a,
    withTiming:           (v: unknown) => v,
    runOnJS:              (fn: unknown) => fn,
    cancelAnimation:      () => {},
    Animated: { createAnimatedComponent, View: AnimatedView },
    default:  { createAnimatedComponent, View: AnimatedView },
  };
});

// ── react-native-gesture-handler ──────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const chain = () => {
    const c: Record<string, unknown> = {};
    ["minPointers", "minDistance", "onBegin", "onUpdate", "onEnd", "numberOfTaps"].forEach(
      (m) => { c[m] = () => c; }
    );
    return c;
  };
  return {
    Gesture: {
      Pan:          chain,
      Pinch:        chain,
      Tap:          chain,
      Simultaneous: (...args: unknown[]) => args[0],
      Exclusive:    (...args: unknown[]) => args[0],
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// ── react-native-svg ──────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => ({
  Svg: () => null, Rect: () => null, G: () => null,
  Text: () => null, SvgUri: () => null, SvgXml: () => null,
  Path: () => null, Ellipse: () => null,
}));

// ── expo-asset ────────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => {}, localUri: "" }) },
}));

// ── Map/floor-plan utils ──────────────────────────────────────────────────────

jest.mock("@/utils/floorPlanCache", () => ({
  getCachedData:        jest.fn().mockReturnValue(null),
  getCachedHash:        jest.fn().mockReturnValue(null),
  getIfValid:           jest.fn().mockReturnValue(null),
  hasCachedData:        jest.fn().mockReturnValue(false),
  initPersistRead:      jest.fn().mockReturnValue(Promise.resolve()),
  resetForServerUpdate: jest.fn(),
  setCached:            jest.fn(),
  setFallbackEmpty:     jest.fn(),
}));

jest.mock("@/utils/mapViewport", () => ({
  SVG_VIEWBOX_W:       3592.55,
  SVG_VIEWBOX_H:       2457.41,
  SVG_ASPECT:          3592.55 / 2457.41,
  MIN_SCALE:           0.5,
  MAX_SCALE:           5,
  ZOOM_STOPS:          [{ scale: 1.5 }, { scale: 4 }, { scale: 10 }],
  parseContentViewBox: jest.fn().mockReturnValue(null),
  fitContentViewport:  jest.fn(),
  makeTileViewBox:     jest.fn(),
  tileGridSize:        jest.fn().mockReturnValue(1),
  zoomStopForScale:    jest.fn().mockReturnValue(0),
}));

jest.mock("@/hooks/useScanHistory", () => ({
  useScanHistory: jest.fn(() => ({ history: [], addEntry: jest.fn() })),
}));

jest.mock("@/utils/scanHistory", () => ({}));

// ── Imports (after all mocks) ─────────────────────────────────────────────────

import React from "react";
import renderer, { act } from "react-test-renderer";
// Use require() (not import *) to get the raw CJS module.exports object.
// The ESM namespace created by `import *` has getter-only properties; the
// CJS object returned by require() has plain writable properties so we can
// install the FlatList spy with a simple assignment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ReactNativeModule = require("react-native") as Record<string, unknown>;
import SearchScreen from "../app/(tabs)/index";

// ── AppContext: configure the auto-mapped file-level mock ─────────────────────

// jest.config.js maps @/contexts/AppContext → __mocks__/contexts/AppContext.js
// which exports useApp as a jest.fn(). Import and configure it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

function makeAppContext(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      textSize:                   "normal" as const,
      defaultConfidenceThreshold: 50,
      themeMode:                  "system" as const,
      shelfViewEnabled:           true,
      scanSound:                  true,
      dimensionUnit:              "mm" as const,
    },
    updateSetting:           jest.fn(),
    logout:                  jest.fn(),
    clearCache:              jest.fn(),
    isLoading:               false,
    isAdmin:                 false,
    adminToken:              null,
    registerLogoutHandler:   jest.fn(() => () => {}),
    setPendingMapFocus:      jest.fn(),
    showToast:               jest.fn(),
    setPinnedParts:          jest.fn(),
    pendingMeasureSearch:    null,
    setPendingMeasureSearch: jest.fn(),
    textFontScale:           1.0,
    pinnedParts:             [],
    ...overrides,
  };
}

// ── FlatList spy ──────────────────────────────────────────────────────────────
//
// TypeScript compiles `import { FlatList } from "react-native"` as
// property accesses on the cached require'd object (`react_native_1.FlatList`).
// Replacing the property on the shared module export object in beforeAll
// intercepts every FlatList render call inside SearchScreen.

let lastFlatListData: unknown;
let origFlatList: (props: Record<string, unknown>) => React.ReactElement | null;

beforeAll(() => {
  origFlatList = ReactNativeModule.FlatList as (props: Record<string, unknown>) => React.ReactElement | null;
  ReactNativeModule.FlatList = (props: Record<string, unknown>) => {
    lastFlatListData = props.data;
    return origFlatList(props);
  };
});

afterAll(() => {
  ReactNativeModule.FlatList = origFlatList;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSearchData(resultCount = 3, sizeUnknownCount = 0) {
  return {
    results: Array.from({ length: resultCount }, (_, i) => ({
      item: { id: String(i), catalog: `CAT-${i}`, description: `Item ${i}`, binLocations: [], dimensions: null },
      confidence: 0.9 - i * 0.1,
      matchReason: "keyword",
      seriesLabel: null,
      variants: [],
    })),
    sizeUnknownResults: Array.from({ length: sizeUnknownCount }, (_, i) => ({
      item: { id: `u${i}`, catalog: `UCAT-${i}`, description: `Unknown ${i}`, binLocations: [], dimensions: null },
      confidence: 0.5,
      matchReason: "size",
      seriesLabel: null,
      variants: [],
    })),
    belowThreshold: 0,
    dimensionCounts: undefined,
  };
}

function makeSearchMutation(
  data: ReturnType<typeof makeSearchData> | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    mutate:      jest.fn(),
    mutateAsync: jest.fn(),
    isPending:   false,
    isSuccess:   data !== null,
    isError:     false,
    data:        data ?? undefined,
    reset:       jest.fn(),
    ...overrides,
  };
}

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

// ── Suppress deprecation noise ────────────────────────────────────────────────

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
afterAll(() => {
  (console.error as jest.Mock).mockRestore?.();
});

beforeEach(() => {
  lastFlatListData = undefined;
  useApp.mockReturnValue(makeAppContext());
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("flatListData memo in SearchScreen — reference stability", () => {
  it("keeps the same FlatList data reference across an unrelated re-render", async () => {
    const searchData = makeSearchData(3);
    mockUseSearchInventory.mockReturnValue(makeSearchMutation(searchData));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SearchScreen />);
    });

    // Let on-mount effects run (queryCache load, keyboard listeners, etc.).
    // These cause internal state updates — "unrelated" re-renders — without
    // touching searchMutation.data.
    await flushPromises();

    const before = lastFlatListData;
    expect(before).toBeDefined();

    // Force another re-render with the same search mutation (simulates any
    // subsequent unrelated state change: keyboard open/close, layout event,
    // etc.).  The FlatList data reference must remain identical.
    await act(async () => {
      tree.update(<SearchScreen />);
    });

    const after = lastFlatListData;

    expect(after).toBe(before);
  });

  it("produces a new FlatList data reference when searchMutation.data changes", async () => {
    const searchDataA = makeSearchData(3);
    const searchDataB = makeSearchData(2); // different result count → different array

    mockUseSearchInventory.mockReturnValue(makeSearchMutation(searchDataA));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SearchScreen />);
    });

    await flushPromises();

    const before = lastFlatListData;
    expect(before).toBeDefined();

    // Switch the mutation to return different results
    mockUseSearchInventory.mockReturnValue(makeSearchMutation(searchDataB));

    await act(async () => {
      tree.update(<SearchScreen />);
    });

    const after = lastFlatListData;

    // Memo must invalidate when deps change — different data → new reference
    expect(after).not.toBe(before);
  });
});
