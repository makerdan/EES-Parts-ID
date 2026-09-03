/**
 * Navigation-level lifecycle regression for the real Search route.
 *
 * Focused hook tests can prove that individual cleanup callbacks exist, but
 * they cannot prove that the route is actually unmounted when the app changes
 * destinations.  This test mounts the production tab layout and SearchScreen
 * together, then switches the navigation boundary to a login route.
 *
 * Covered guarantees:
 *  - a pending inventory sync is aborted when navigation removes SearchScreen;
 *  - the AppState subscription is removed with the route;
 *  - a failed sync's 30-second retry cannot fire after navigation or sign out;
 *  - returning the app to the foreground cannot revive work from the old route.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import * as fs from "fs";
import * as path from "path";
import React, { useState } from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock("expo-router", () => {
  const React = require("react");
  const Tabs = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("navigation-tabs", null, children);
  Tabs.Screen = () => null;
  return {
    Tabs,
    router: { navigate: jest.fn(), push: jest.fn() },
    useFocusEffect: jest.fn(),
    useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }),
  };
});

jest.mock("expo-blur", () => ({
  BlurView: () => null,
}));

// ── API and storage ───────────────────────────────────────────────────────────

const mockUseSearchInventory = jest.fn();
const mockFetchInventoryPages = jest.fn();
const mockFetchWithAuth = jest.fn();
const mockAsyncGet = jest.fn();

jest.mock("@workspace/api-client-react", () => ({
  useSearchInventory: (...args: unknown[]) => mockUseSearchInventory(...args),
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
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: (...args: unknown[]) => mockAsyncGet(...args),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: true }),
  },
  NetInfoStateType: { unknown: "unknown", none: "none", wifi: "wifi", cellular: "cellular" },
}));

jest.mock("fuse.js", () =>
  jest.fn().mockImplementation(() => ({ search: jest.fn().mockReturnValue([]) })),
);

// ── Production child components that are outside this route's lifecycle ───────

jest.mock("@/components/ResultCard", () => ({ ResultCard: () => null }));
jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/FilterPanel", () => ({
  FilterPanel: () => null,
  ConfidenceSlider: () => null,
}));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/PartDetailsEditor", () => ({ PartDetailsEditor: () => null }));
jest.mock("@/components/BrowseByAisle", () => ({ BrowseByAisle: () => null }));
jest.mock("@/components/BrowseByCategory", () => ({ BrowseByCategory: () => null }));
jest.mock("@/components/BarcodeScanModal", () => ({ BarcodeScanModal: () => null }));
jest.mock("@/components/BarcodeScreen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/AISearchFallback", () => ({
  AIZeroResultsCard: () => null,
  SearchedAsRow: () => null,
}));
jest.mock("@/components/KeyboardDoneInput", () => ({ KeyboardDoneInput: () => null }));
jest.mock("@/components/RecentSearchesPanel", () => ({ RecentSearchesPanel: () => null }));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/constants/colors", () => ({
  __esModule: true,
  default: {
    light: {
      background: "#fff",
      foreground: "#000",
      card: "#fff",
      border: "#ccc",
      primary: "#3b82f6",
      primaryForeground: "#fff",
      muted: "#f1f5f9",
      mutedForeground: "#64748b",
      destructive: "#ef4444",
      success: "#22c55e",
      warning: "#f59e0b",
      overlay: "#00000066",
    },
    dark: {
      background: "#000",
      foreground: "#fff",
      card: "#111",
      border: "#333",
      primary: "#3b82f6",
      primaryForeground: "#fff",
      muted: "#1e293b",
      mutedForeground: "#94a3b8",
      destructive: "#ef4444",
      success: "#22c55e",
      warning: "#f59e0b",
      overlay: "#00000066",
    },
    radius: 8,
  },
}));

jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));
jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));
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
  FUSE_SYNC_MAX_AGE_MS: Infinity,
  FUSE_SOFT_STALE_MS: Infinity,
  getFuseCacheSyncedAt: jest.fn().mockResolvedValue(null),
  parseFuseCacheItems: jest.fn().mockReturnValue(null),
  replaceBarcodeCacheWithServerItems: jest.fn().mockResolvedValue(undefined),
  lookupByBarcodeOffline: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/utils/searchHelpers", () => ({
  QUERY_CACHE_KEY: "query_cache",
  buildQueryKey: jest.fn().mockReturnValue("test-key"),
  buildSearchBody: jest.fn().mockReturnValue({ keywords: "", confidenceThreshold: 50 }),
  pruneExpired: jest.fn((cache: unknown) => cache),
  formatRelativeAge: jest.fn().mockReturnValue("1 hour ago"),
  formatStaleCacheWarning: jest.fn().mockReturnValue(""),
  resolveOfflineFallback: jest.fn().mockResolvedValue({ results: [], cacheType: null }),
  fetchInventoryPages: (...args: unknown[]) => mockFetchInventoryPages(...args),
}));
jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));
jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
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
jest.mock("@/lib/aisleHierarchy", () => ({
  parseBin: jest.fn().mockReturnValue({ aisle: "01", bay: "02", shelf: "A" }),
}));

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const createAnimatedComponent = (component: unknown) => component;
  return {
    __esModule: true,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useAnimatedReaction: () => {},
    withSpring: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
    runOnJS: (fn: unknown) => fn,
    cancelAnimation: jest.fn(),
    Animated: {
      createAnimatedComponent,
      View: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("rn-animated-view", null, children),
    },
    default: { createAnimatedComponent },
  };
});

jest.mock("react-native-gesture-handler", () => ({
  Gesture: {
    Pan: () => ({}),
    Pinch: () => ({}),
    Tap: () => ({}),
    Simultaneous: (gesture: unknown) => gesture,
    Exclusive: (gesture: unknown) => gesture,
  },
  GestureDetector: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

jest.mock("react-native-svg", () => ({
  Svg: () => null,
  Rect: () => null,
  G: () => null,
  Text: () => null,
  SvgUri: () => null,
  SvgXml: () => null,
  Path: () => null,
  Ellipse: () => null,
}));
jest.mock("expo-asset", () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => {}, localUri: "" }) },
}));
jest.mock("@/utils/floorPlanCache", () => ({
  getCachedData: jest.fn().mockReturnValue(null),
  getCachedHash: jest.fn().mockReturnValue(null),
  getIfValid: jest.fn().mockReturnValue(null),
  hasCachedData: jest.fn().mockReturnValue(false),
  initPersistRead: jest.fn().mockReturnValue(Promise.resolve()),
  resetForServerUpdate: jest.fn(),
  setCached: jest.fn(),
  setFallbackEmpty: jest.fn(),
}));
jest.mock("@/utils/mapViewport", () => ({
  SVG_VIEWBOX_W: 3592.55,
  SVG_VIEWBOX_H: 2457.41,
  SVG_ASPECT: 3592.55 / 2457.41,
  MIN_SCALE: 0.5,
  MAX_SCALE: 5,
  ZOOM_STOPS: [{ scale: 1.5 }, { scale: 4 }, { scale: 10 }],
  parseContentViewBox: jest.fn().mockReturnValue(null),
  fitContentViewport: jest.fn(),
  makeTileViewBox: jest.fn(),
  tileGridSize: jest.fn().mockReturnValue(1),
  zoomStopForScale: jest.fn().mockReturnValue(0),
}));
jest.mock("@/hooks/useScanHistory", () => ({
  useScanHistory: jest.fn(() => ({ history: [], addEntry: jest.fn() })),
}));
jest.mock("@/utils/scanHistory", () => ({}));

// ── App context and route imports ──────────────────────────────────────────────

const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };
const { AppState } = require("react-native") as {
  AppState: {
    addEventListener: jest.Mock;
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SearchScreen = (require("../app/(tabs)/index") as {
  default: React.ComponentType;
}).default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TabLayout = (require("../app/(tabs)/_layout") as {
  default: React.ComponentType;
}).default;

type AppStateListener = (state: string) => void;
type Route = "search" | "login";

const appStateListeners = new Set<AppStateListener>();
const appStateRemove = jest.fn();
let registeredLogoutHandler: (() => void) | null = null;
let navigateToLogin: (() => void) | null = null;

function emitAppState(state: string): void {
  for (const listener of appStateListeners) listener(state);
}

function makeAppContext() {
  const context = {
    isAuthenticated: true,
    approvalStatus: "approved" as const,
    recheckApprovalStatus: jest.fn().mockResolvedValue(undefined),
    settings: {
      textSize: "normal" as const,
      defaultConfidenceThreshold: 50,
      themeMode: "light" as const,
      shelfViewEnabled: true,
      scanSound: true,
      dimensionUnit: "mm" as const,
    },
    updateSetting: jest.fn(),
    logout: jest.fn(() => {
      registeredLogoutHandler?.();
      navigateToLogin?.();
    }),
    logoutAdmin: jest.fn().mockResolvedValue(undefined),
    clearCache: jest.fn().mockResolvedValue(undefined),
    isLoading: false,
    isAdmin: false,
    adminToken: null,
    registerLogoutHandler: jest.fn((handler: () => void) => {
      registeredLogoutHandler = handler;
      return () => {
        if (registeredLogoutHandler === handler) registeredLogoutHandler = null;
      };
    }),
    setPendingMapFocus: jest.fn(),
    showToast: jest.fn(),
    setPinnedParts: jest.fn(),
    pendingMeasureSearch: null,
    setPendingMeasureSearch: jest.fn(),
    pendingInventorySearch: null,
    setPendingInventorySearch: jest.fn(),
    pendingLidarDims: null,
    setPendingLidarDims: jest.fn(),
    textFontScale: 1,
    pinnedParts: [],
    resumeProgress: {},
    setResumeProgress: jest.fn(),
  };
  return context;
}

/**
 * This is the smallest test representation of the app's route boundary: the
 * real production tab layout is mounted, and its real Search route is replaced
 * by the login route when navigation or sign-out occurs.
 */
function AppNavigationBoundary() {
  const [route, setRoute] = useState<Route>("search");
  navigateToLogin = () => setRoute("login");

  return (
    <>
      <TabLayout />
      {route === "search" ? (
        <SearchScreen />
      ) : (
        <Text testID="login-route">Login route</Text>
      )}
    </>
  );
}

function flushPromises() {
  return act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  appStateListeners.clear();
  registeredLogoutHandler = null;
  navigateToLogin = null;
  appStateRemove.mockClear();
  AppState.addEventListener.mockImplementation(
    (_event: string, listener: AppStateListener) => {
      appStateListeners.add(listener);
      return {
        remove: jest.fn(() => {
          appStateListeners.delete(listener);
          appStateRemove();
        }),
      };
    },
  );

  mockAsyncGet.mockReset();
  mockAsyncGet.mockResolvedValue(null);
  mockFetchInventoryPages.mockReset();
  mockFetchWithAuth.mockReset();
  mockUseSearchInventory.mockReset();
  mockUseSearchInventory.mockReturnValue({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    reset: jest.fn(),
  });
  useApp.mockReset();
  useApp.mockReturnValue(makeAppContext());
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  appStateListeners.clear();
  registeredLogoutHandler = null;
  navigateToLogin = null;
});

describe("Parts ID navigation lifecycle", () => {
  it("aborts the real Search route request and removes AppState work on navigation away", async () => {
    const requestSignals: Array<AbortSignal> = [];
    const pendingRequest: { resolve: ((value: unknown) => void) | null } = { resolve: null };

    mockFetchInventoryPages.mockImplementation(
      async (fetchPage: (page: number, pageSize: number) => Promise<unknown>) => {
        await fetchPage(1, 500);
        return [];
      },
    );
    mockFetchWithAuth.mockImplementation(
      (_url: string, options: { signal?: AbortSignal }) => {
        if (options.signal) requestSignals.push(options.signal);
        return new Promise((resolve) => {
          pendingRequest.resolve = resolve;
        });
      },
    );

    const tree = await render(<AppNavigationBoundary />);
    await flushPromises();

    expect(mockFetchInventoryPages).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(appStateListeners.size).toBe(1);

    await act(async () => {
      navigateToLogin?.();
      await Promise.resolve();
    });

    expect(tree.getByTestId("login-route")).toBeTruthy();
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]).toBeDefined();
    expect(requestSignals[0]!.aborted).toBe(true);
    expect(appStateListeners.size).toBe(0);
    expect(appStateRemove).toHaveBeenCalledTimes(1);

    // Let the old promise settle after unmount, just as a late network reply
    // would in production. It must not schedule follow-up work.
    const settleRequest = pendingRequest.resolve;
    if (!settleRequest) throw new Error("The inventory request did not start");
    settleRequest({ ok: true, json: async () => ({ items: [], total: 0 }) });
    await flushPromises();
    emitAppState("active");
    jest.advanceTimersByTime(60_000);
    await flushPromises();

    expect(mockFetchInventoryPages).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    await tree.unmount();
  });

  it("cancels a failed sync retry through the real Settings → Sign Out route transition", async () => {
    mockFetchInventoryPages.mockImplementation(
      async (fetchPage: (page: number, pageSize: number) => Promise<unknown>) => {
        await fetchPage(1, 500);
        return [];
      },
    );
    mockFetchWithAuth.mockRejectedValue(new Error("offline"));

    const tree = await render(<AppNavigationBoundary />);
    await flushPromises();

    expect(mockFetchInventoryPages).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.press(tree.getByLabelText("Settings"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.press(tree.getByText("Sign Out"));
      await Promise.resolve();
    });
    await flushPromises();

    expect(tree.getByTestId("login-route")).toBeTruthy();
    expect(useApp.mock.results[0]?.value.logout).toHaveBeenCalledTimes(1);
    expect(appStateListeners.size).toBe(0);

    emitAppState("active");
    jest.advanceTimersByTime(60_000);
    await flushPromises();
    jest.runOnlyPendingTimers();
    await flushPromises();

    expect(mockFetchInventoryPages).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    await tree.unmount();
  });
});

describe("Parts ID navigation registration", () => {
  it("keeps Search registered as the real tab route", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../app/(tabs)/_layout.tsx"),
      "utf8",
    );
    expect(source).toContain('<Tabs.Screen');
    expect(source).toMatch(/name=["']index["']/);
    expect(source).toContain('title: "Search"');
  });
});