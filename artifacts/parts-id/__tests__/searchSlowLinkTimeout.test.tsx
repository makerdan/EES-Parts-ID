/**
 *
 * Slow-but-connected link regression coverage for the SearchScreen 8-second
 * timeout fallback (app/(tabs)/index.tsx — handleSearch, SEARCH_TIMEOUT_MS,
 * runOfflineFallback).
 *
 * Why
 * ───
 * The pre-search NetInfo.fetch() check only skips the network request when the
 * device reports itself *disconnected*. A device can be "connected" (WiFi
 * associated) yet unreachable — captive portal, packet loss, dead uplink. In
 * that case searchMutation.mutate() never resolves (no onSuccess / onError),
 * and the ONLY thing that rescues the user is the 8-second timeout, which
 * clears the loading spinner and swaps in the offline fallback banner. These
 * tests lock in that behaviour so a future change can't silently leave users
 * staring at a spinner for 8s with no feedback.
 *
 * Strategy
 * ────────
 * - NetInfo.fetch() reports `isConnected: true` (the slow-but-connected case).
 * - searchMutation is a stateful mock whose `mutate` flips `isPending` true and
 *   whose `reset` flips it false — but it NEVER fires onSuccess/onError, so the
 *   request "hangs" exactly like a stalled socket.
 * - Fake timers let us advance exactly SEARCH_TIMEOUT_MS (8s) and assert the
 *   spinner is gone and the correct offline banner is shown.
 *
 * Covered scenarios
 * ─────────────────
 * 1. Cached-results path: a prior Fuse cache exists (cachedCount > 0) and the
 *    offline fallback resolves cached hits → "📡 Offline — showing cached
 *    results." banner.
 * 2. No-cache path: the Fuse index is empty (cachedCount === 0) → "Offline
 *    search unavailable / Connect to the internet…" empty state.
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
// Device is "connected" (associated) but the request will hang — this is the
// slow-but-connected case the timeout is meant to rescue.

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: true }),
  },
  NetInfoStateType: { unknown: "unknown", none: "none", wifi: "wifi", cellular: "cellular" },
}));

// ── @react-native-async-storage/async-storage ─────────────────────────────────
// getItem is configured per-test via mockAsyncGet so we can seed (or omit) a
// Fuse cache to drive cachedCount.

const mockAsyncGet = jest.fn().mockResolvedValue(null);

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:     (...args: unknown[]) => mockAsyncGet(...args),
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
// KeyboardDoneInput renders a host node so the test can drive onChangeText /
// onSubmitEditing (the keyboard "search" return that triggers handleSearch).

jest.mock("@/components/KeyboardDoneInput", () => {
  const React = require("react");
  return {
    KeyboardDoneInput: (props: Record<string, unknown>) =>
      React.createElement("keyword-input", props),
  };
});

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
  FUSE_SOFT_STALE_MS:       Infinity,
  lookupByBarcodeOffline:   jest.fn().mockResolvedValue(null),
  // Mirrors the real parser: envelope format { items: [...] } or legacy plain array.
  parseFuseCacheItems: jest.fn((raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.items)) return parsed.items;
      return null;
    } catch {
      return null;
    }
  }),
  replaceBarcodeCacheWithServerItems: jest.fn().mockResolvedValue(undefined),
}));

// resolveOfflineFallback is configured per-test via mockResolveOfflineFallback.
const mockResolveOfflineFallback = jest.fn();

jest.mock("@/utils/searchHelpers", () => ({
  QUERY_CACHE_KEY:          "query_cache",
  buildQueryKey:            jest.fn().mockReturnValue("test-key"),
  buildSearchBody:          jest.fn().mockReturnValue({ keywords: "", confidenceThreshold: 50 }),
  pruneExpired:             jest.fn((c: unknown) => c),
  formatStaleCacheWarning:  jest.fn().mockReturnValue(""),
  formatRelativeAge:        jest.fn().mockReturnValue("1 hour ago"),
  resolveOfflineFallback:   (...args: unknown[]) => mockResolveOfflineFallback(...args),
  fetchInventoryPages:      jest.fn().mockResolvedValue([]),
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: jest.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) }),
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
import { render, act, RenderResult, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

import SearchScreen from "../app/(tabs)/index";

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
    pendingInventorySearch:  null,
    setPendingInventorySearch: jest.fn(),
    textFontScale:           1.0,
    pinnedParts:             [],
    ...overrides,
  };
}

// ── Stateful search-mutation mock ─────────────────────────────────────────────
//
// `mutate` sets isPending true; `reset` sets it false. It NEVER fires
// onSuccess/onError — this is the whole point: the request hangs on a slow but
// connected link and only the 8s timeout rescues the UI. Because
// mockUseSearchInventory is invoked on every render, reading `mutationPending`
// fresh each call means the returned object always reflects the latest state.

let mutationPending = false;
const mutateFn = jest.fn(() => { mutationPending = true; });
const resetFn = jest.fn(() => { mutationPending = false; });

function installSearchMutation() {
  mutationPending = false;
  mockUseSearchInventory.mockImplementation(() => ({
    mutate:      mutateFn,
    mutateAsync: jest.fn(),
    isPending:   mutationPending,
    isSuccess:   false,
    isError:     false,
    data:        undefined,
    reset:       resetFn,
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Inst = TestInstance;

function gatherText(root: NonNullable<RenderResult["root"]>): string {
  const texts: Array<string> = [];
  root.queryAll(() => true, { includeSelf: true }).forEach((node: Inst) => {
    const kids = node.children;
    if (Array.isArray(kids)) {
      kids.forEach((c) => { if (typeof c === "string") texts.push(c); });
    }
  });
  return texts.join(" | ");
}

function isSpinnerVisible(root: NonNullable<RenderResult["root"]>): boolean {
  return gatherText(root).includes("Searching dictionaries");
}

const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

// Track mounted trees so afterEach can unmount them before flushing
// pending timers; firing the sync-retry backoff timer while still mounted
// triggers async state updates that outlive the suite and emit "Cannot log
// after tests are done" warnings.
const mountedTrees: RenderResult[] = [];

async function mountScreen() {
  const result = await render(<SearchScreen />);
  mountedTrees.push(result);
  // Let mount effects settle (Fuse cache load / sync, history load, etc.).
  await flushMicrotasks();
  return result;
}

// Set the keyword and fire the keyboard "search" return, which calls the async
// handleSearch. Re-reads the input each time so the latest onSubmitEditing (a
// fresh closure per render) is used.
async function triggerSearch(result: RenderResult) {
  const input = () =>
    result.root!.queryAll((n: Inst) => (n.type as unknown as string) === "keyword-input", { includeSelf: true })[0]!;
  await act(async () => {
    fireEvent.changeText(input(), "wire nut");
  });
  await act(async () => {
    await (input().props.onSubmitEditing as () => Promise<void> | void)();
  });
  // The real useSearchInventory re-renders the tree when isPending flips to
  // true. Our hook mock only mutates a plain flag, so drive the equivalent
  // re-render explicitly to surface the loading spinner.
  await result.rerender(<SearchScreen />);
}

beforeEach(() => {
  jest.useFakeTimers();
  useApp.mockReturnValue(makeAppContext());
  installSearchMutation();
  mockAsyncGet.mockReset().mockResolvedValue(null);
  mutateFn.mockClear();
  resetFn.mockClear();
});

afterEach(async () => {
  // Unmount first so component cleanup clears pending timers (sync retry,
  // search timeout) instead of letting runOnlyPendingTimers fire them.
  while (mountedTrees.length > 0) {
    const t = mountedTrees.pop()!;
    await t.unmount();
  }
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SearchScreen 8s timeout on a slow-but-connected link", () => {
  it("shows the cached-results banner and clears the spinner when the request hangs", async () => {
    // Seed a Fuse cache so cachedCount > 0 (items need numeric ids).
    mockAsyncGet.mockImplementation(async (key: string) =>
      key === "fuse_cache"
        ? JSON.stringify([
            { id: 1, catalog: "WIRE-NUT-1", description: "Yellow wire nut", binLocations: [] },
            { id: 2, catalog: "WIRE-NUT-2", description: "Red wire nut", binLocations: [] },
          ])
        : null,
    );
    // Offline fallback resolves to cached hits.
    mockResolveOfflineFallback.mockReturnValue({
      results: [
        {
          item: { id: 1, catalog: "WIRE-NUT-1", description: "Yellow wire nut", binLocations: [], dimensions: null },
          confidence: 0.8,
          matchReason: "offline Fuse match",
          seriesLabel: undefined,
          variants: [],
        },
      ],
      cacheType: "fuse",
    });

    const result = await mountScreen();
    await triggerSearch(result);

    // The request is in flight and stalled — spinner is showing, no banner yet.
    expect(isSpinnerVisible(result.root!)).toBe(true);
    expect(mutateFn).toHaveBeenCalledTimes(1);
    expect(gatherText(result.root!)).not.toContain("Offline — showing cached results");

    // Fire the 8-second timeout and let the async offline fallback settle.
    await act(async () => {
      jest.advanceTimersByTime(8000);
    });
    await flushMicrotasks();

    // Spinner cleared, cached-results offline banner shown.
    expect(resetFn).toHaveBeenCalled();
    expect(isSpinnerVisible(result.root!)).toBe(false);
    expect(gatherText(result.root!)).toContain("Offline — showing cached results");
  });

  it("shows the no-cache empty state and clears the spinner when the request hangs", async () => {
    // No Fuse cache on disk → cachedCount stays 0 (mount sync returns []).
    mockAsyncGet.mockResolvedValue(null);
    // Offline fallback finds nothing (empty index).
    mockResolveOfflineFallback.mockReturnValue({ results: [], cacheType: "fuse" });

    const result = await mountScreen();
    await triggerSearch(result);

    expect(isSpinnerVisible(result.root!)).toBe(true);
    expect(mutateFn).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(8000);
    });
    await flushMicrotasks();

    expect(resetFn).toHaveBeenCalled();
    expect(isSpinnerVisible(result.root!)).toBe(false);
    const text = gatherText(result.root!);
    expect(text).toContain("Offline search unavailable");
    expect(text).toContain("Connect to the internet and search once to enable offline mode");
  });
});
