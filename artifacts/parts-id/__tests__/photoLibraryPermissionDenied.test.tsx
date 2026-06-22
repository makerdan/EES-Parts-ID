/**
 * @jest-environment node
 *
 * Behavioral regression test: photo.tsx pickImage("library") permanent-denial flow.
 *
 * When `requestMediaLibraryPermissionsAsync` returns `{ status: "denied" }`
 * (iOS photo-library denied), `pickImage("library")` must:
 *   - call `setInlineError` with a Settings-directing message
 *   - NOT call `launchImageLibraryAsync`
 *
 * This mounts the real PhotoScreen component with all dependencies stubbed so
 * that the actual `pickImage` callback runs at runtime, confirming the guard
 * works end-to-end rather than just being present in the source text.
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── expo-router ──────────────────────────────────────────────────────────────

const mockRouterNavigate = jest.fn();
const mockRouterPush    = jest.fn();
let capturedFocusEffect: (() => void) | null = null;

jest.mock("expo-router", () => ({
  router: { navigate: mockRouterNavigate, push: mockRouterPush },
  useFocusEffect: (cb: () => void) => { capturedFocusEffect = cb; },
}));

// ─── expo-image-picker ────────────────────────────────────────────────────────
// requestMediaLibraryPermissionsAsync is set to return "denied" so the library
// path in pickImage() hits the setInlineError guard rather than opening the picker.

const mockLaunchLibrary   = jest.fn().mockResolvedValue({ canceled: true, assets: [] });
const mockLaunchCamera    = jest.fn().mockResolvedValue({ canceled: true });
const mockRequestCamera   = jest.fn().mockResolvedValue({ status: "granted" });
const mockRequestLibrary  = jest.fn().mockResolvedValue({ status: "denied" });

jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync:       (...args: unknown[]) => mockRequestCamera(...args),
  requestMediaLibraryPermissionsAsync: (...args: unknown[]) => mockRequestLibrary(...args),
  launchImageLibraryAsync:             (...args: unknown[]) => mockLaunchLibrary(...args),
  launchCameraAsync:                   (...args: unknown[]) => mockLaunchCamera(...args),
}));

// ─── @workspace/api-client-react ─────────────────────────────────────────────

const mockIdentifyMutateAsync = jest.fn();
const mockSearchMutateAsync   = jest.fn();

jest.mock("@workspace/api-client-react", () => ({
  useAiIdentifyPart: jest.fn(() => ({
    mutateAsync:  mockIdentifyMutateAsync,
    isPending:    false,
    isSuccess:    false,
    isError:      false,
    reset:        jest.fn(),
  })),
  useSearchInventory: jest.fn(() => ({
    mutate:       jest.fn(),
    mutateAsync:  mockSearchMutateAsync,
    isPending:    false,
    isSuccess:    false,
    isError:      false,
    reset:        jest.fn(),
  })),
  setAuthTokenGetter: jest.fn(),
  setBaseUrl:         jest.fn(),
  lookupByBarcode:    jest.fn(),
  aiIdentifyPart:     jest.fn(),
}));

// ─── @react-native-community/netinfo ─────────────────────────────────────────

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: true }),
  },
  NetInfoStateType: { unknown: "unknown", none: "none", wifi: "wifi", cellular: "cellular" },
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:     jest.fn().mockResolvedValue(null),
  setItem:     jest.fn().mockResolvedValue(undefined),
  removeItem:  jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

// ─── fuse.js ─────────────────────────────────────────────────────────────────

jest.mock("fuse.js", () =>
  jest.fn().mockImplementation(() => ({ search: jest.fn().mockReturnValue([]) }))
);

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
    primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
    mutedForeground: "#64748b", destructive: "#ef4444", success: "#22c55e",
    warning: "#f59e0b", accent: "#f1f5f9", accentForeground: "#000",
  }),
}));

// ─── @/components stubs ───────────────────────────────────────────────────────

jest.mock("@/components/ResultCard",       () => ({ ResultCard: () => null }));
jest.mock("@/components/MeasurePartScreen",() => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/FilterPanel",      () => ({ FilterPanel: () => null, ConfidenceSlider: () => null }));
jest.mock("@/components/ReferenceModal",   () => ({ ReferenceModal: () => null }));
jest.mock("@/components/PartDetailsEditor",() => ({ PartDetailsEditor: () => null }));
jest.mock("@/components/BrowseByAisle",    () => ({ BrowseByAisle: () => null }));
jest.mock("@/components/BrowseByCategory", () => ({ BrowseByCategory: () => null }));
jest.mock("@/components/BarcodeScanModal", () => ({ BarcodeScanModal: () => null }));
jest.mock("@/components/BarcodeScreen",    () => ({ __esModule: true, default: () => null }));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ─── @/constants/colors ──────────────────────────────────────────────────────

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

// ─── Utility mocks ────────────────────────────────────────────────────────────

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

jest.mock("@/utils/resizeImage", () => ({
  resizeImage: jest.fn().mockResolvedValue({ uri: "fake://resized.jpg", base64: "fakebase64" }),
}));

jest.mock("@/hooks/useScanHistory", () => ({
  useScanHistory: jest.fn(() => ({ history: [], addEntry: jest.fn() })),
}));

jest.mock("@/utils/scanHistory", () => ({}));

// ─── react-native-reanimated ─────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const makeShared = (v: unknown) => ({ value: v });
  const AnimatedView = ({ children, style }: { children?: React.ReactNode; style?: unknown }) =>
    React.createElement("rn-animated-view", { style }, children);
  const createAnimatedComponent = (C: unknown) => C;
  return {
    __esModule: true,
    useSharedValue:          makeShared,
    useAnimatedStyle:        () => ({}),
    useAnimatedProps:        () => ({}),
    useAnimatedReaction:     () => {},
    withSpring:              (v: unknown) => v,
    withRepeat:              (a: unknown) => a,
    withTiming:              (v: unknown) => v,
    runOnJS:                 (fn: unknown) => fn,
    Animated: { createAnimatedComponent, View: AnimatedView },
    default:  { createAnimatedComponent, View: AnimatedView },
  };
});

// ─── react-native-gesture-handler ────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    ["minPointers", "minDistance", "onBegin", "onUpdate", "onEnd", "numberOfTaps"].forEach(
      m => { c[m] = () => c; }
    );
    return c;
  };
  return {
    Gesture: {
      Pan: chain,
      Pinch: chain,
      Tap: chain,
      Simultaneous: (...args: unknown[]) => args[0],
      Exclusive: (...args: unknown[]) => args[0],
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => ({
  Svg: () => null, Rect: () => null, G: () => null, Text: () => null,
  SvgUri: () => null, SvgXml: () => null, Path: () => null, Ellipse: () => null,
}));

// ─── expo-asset ──────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => {}, localUri: "" }) },
}));

// ─── @/utils/floorPlanCache ───────────────────────────────────────────────────

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

// ─── @/utils/mapViewport ─────────────────────────────────────────────────────

jest.mock("@/utils/mapViewport", () => ({
  SVG_VIEWBOX_W:        3592.55,
  SVG_VIEWBOX_H:        2457.41,
  SVG_ASPECT:           3592.55 / 2457.41,
  MIN_SCALE:            0.5,
  MAX_SCALE:            5,
  ZOOM_STOPS:           [{ scale: 1.5 }, { scale: 4 }, { scale: 10 }],
  parseContentViewBox:  jest.fn().mockReturnValue(null),
  fitContentViewport:   jest.fn(),
  makeTileViewBox:      jest.fn(),
  tileGridSize:         jest.fn().mockReturnValue(1),
  zoomStopForScale:     jest.fn().mockReturnValue(0),
}));

// ─── AppContext (via moduleNameMapper → __mocks__/contexts/AppContext.js) ─────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── Subject under test ───────────────────────────────────────────────────────

import PhotoScreen from "../app/(tabs)/photo";

// ─── Suppress react-test-renderer deprecation noise ──────────────────────────

beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation((msg: unknown, ...args: unknown[]) => {
    if (typeof msg === "string" && (
      msg.includes("react-test-renderer is deprecated") ||
      msg.includes("Warning:")
    )) return;
    // eslint-disable-next-line no-console
    console.warn(msg, ...args);
  });
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Tree-walking helpers ─────────────────────────────────────────────────────

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

function allTextContent(root: Inst): string {
  return root
    .findAll(n => (n.type as string) === "rn-text", { deep: true })
    .map(n => instText(n))
    .join(" ");
}

// ─── Flush helpers ────────────────────────────────────────────────────────────

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

// ─── Per-test setup/teardown ──────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

function makeAppMock(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      textSize: "normal" as const,
      defaultConfidenceThreshold: 50,
      themeMode: "system" as const,
      shelfViewEnabled: true,
      scanSound: true,
      dimensionUnit: "mm" as const,
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

beforeEach(() => {
  jest.clearAllMocks();
  useApp.mockReturnValue(makeAppMock());
  capturedFocusEffect = null;
  // Reset library permission mock to denied (the subject of this test file)
  mockRequestLibrary.mockResolvedValue({ status: "denied" });
});

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
});

async function renderPhotoScreen(appOverrides: Record<string, unknown> = {}) {
  useApp.mockReturnValue(makeAppMock(appOverrides));
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<PhotoScreen />); });
  activeTree = tree;
  await flushPromises();
  return tree;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PhotoScreen — pickImage("library") with denied photo library permission', () => {

  it("calls requestMediaLibraryPermissionsAsync when the Photo Library button is tapped", async () => {
    const tree = await renderPhotoScreen();

    const btn = findPressable(tree.root, "Photo Library");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });
    await flushPromises();

    expect(mockRequestLibrary).toHaveBeenCalledTimes(1);
  });

  it("shows a Settings-directing error message when permission is denied", async () => {
    const tree = await renderPhotoScreen();

    const btn = findPressable(tree.root, "Photo Library");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });
    await flushPromises();

    const text = allTextContent(tree.root);
    expect(text).toMatch(/Settings/i);
    expect(text).toMatch(/denied|access/i);
  });

  it("does NOT call launchImageLibraryAsync when permission is denied", async () => {
    const tree = await renderPhotoScreen();

    const btn = findPressable(tree.root, "Photo Library");
    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });
    await flushPromises();

    expect(mockLaunchLibrary).not.toHaveBeenCalled();
  });

  it("error message contains the word 'library' or 'photo' so the user understands what was denied", async () => {
    const tree = await renderPhotoScreen();

    const btn = findPressable(tree.root, "Photo Library");
    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });
    await flushPromises();

    const text = allTextContent(tree.root).toLowerCase();
    expect(text.includes("library") || text.includes("photo")).toBe(true);
  });
});

describe('PhotoScreen — pickImage("library") with granted photo library permission', () => {

  beforeEach(() => {
    mockRequestLibrary.mockResolvedValue({ status: "granted" });
  });

  it("calls launchImageLibraryAsync when permission is granted", async () => {
    const tree = await renderPhotoScreen();

    const btn = findPressable(tree.root, "Photo Library");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });
    await flushPromises();

    expect(mockLaunchLibrary).toHaveBeenCalledTimes(1);
  });

  it("does NOT show a denial error when permission is granted", async () => {
    mockLaunchLibrary.mockResolvedValue({ canceled: true, assets: [] });
    const tree = await renderPhotoScreen();

    const btn = findPressable(tree.root, "Photo Library");
    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });
    await flushPromises();

    const text = allTextContent(tree.root);
    expect(text).not.toMatch(/denied/i);
  });
});
