/**
 * @jest-environment node
 *
 * Tests that the Zone Editor button in MapScreen is guarded by the `isAdmin`
 * flag from AppContext.
 *
 * The button lives inside `{isAdmin && <View …>…</View>}` (map.tsx ~line 398).
 * Without a test, a future refactor of that outer guard could silently expose
 * the button to non-admin users.
 *
 * Two cases are covered:
 *   A) isAdmin=false — the Pressable with accessibilityLabel "Open Zone Editor"
 *      must NOT appear in the rendered tree.
 *   B) isAdmin=true  — the Pressable with accessibilityLabel "Open Zone Editor"
 *      MUST appear in the rendered tree.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── expo-router ──────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  router:         { navigate: jest.fn(), push: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
  useRouter:      () => ({ navigate: jest.fn(), push: jest.fn() }),
}));

// ─── expo-screen-orientation ─────────────────────────────────────────────────

jest.mock("expo-screen-orientation", () => ({
  unlockAsync:     jest.fn().mockResolvedValue(undefined),
  lockAsync:       jest.fn().mockResolvedValue(undefined),
  OrientationLock: { PORTRAIT_UP: "PORTRAIT_UP" },
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── expo-clipboard ──────────────────────────────────────────────────────────

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather:                 () => null,
  MaterialCommunityIcons:  () => null,
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background:         "#fff",
    foreground:         "#000",
    card:               "#fff",
    border:             "#ccc",
    primary:            "#3b82f6",
    primaryForeground:  "#fff",
    muted:              "#f1f5f9",
    mutedForeground:    "#64748b",
    destructive:        "#ef4444",
    success:            "#22c55e",
    warning:            "#f59e0b",
    accent:             "#f1f5f9",
    accentForeground:   "#000",
  }),
}));

// ─── @/utils/useTrackScreen ──────────────────────────────────────────────────

jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));

// ─── @/utils/orientationLock ─────────────────────────────────────────────────

jest.mock("@/utils/orientationLock", () => ({
  swallowOrientationNotAvailable: jest.fn(),
}));

// ─── @/utils/offlineBarcode ──────────────────────────────────────────────────

jest.mock("@/utils/offlineBarcode", () => ({
  FUSE_CACHE_KEY:           "fuse_cache",
  FUSE_CACHE_SYNCED_AT_KEY: "fuse_synced_at",
  getFuseCacheSyncedAt:     jest.fn().mockResolvedValue(Date.now()),
  FUSE_SYNC_MAX_AGE_MS:     Infinity,
  lookupByBarcodeOffline:   jest.fn().mockResolvedValue(null),
}));

// ─── @/hooks/useWarehouseZones ───────────────────────────────────────────────

jest.mock("@/hooks/useWarehouseZones", () => ({
  useWarehouseZones: jest.fn(() => ({
    zones:   [],
    loading: false,
    error:   false,
    refetch: jest.fn(),
  })),
}));

// ─── @/components/WarehouseMapView ───────────────────────────────────────────

jest.mock("@/components/WarehouseMapView", () => ({
  WarehouseMapView: () => null,
}));

// ─── @/components/ZoneActionMenu ─────────────────────────────────────────────

jest.mock("@/components/ZoneActionMenu", () => ({
  ZoneActionMenu: () => null,
}));

// ─── @/components/AisleSummarySheet ──────────────────────────────────────────

jest.mock("@/components/AisleSummarySheet", () => ({
  AisleSummarySheet: () => null,
}));

// ─── @/components/BrowseByAisle ──────────────────────────────────────────────

jest.mock("@/components/BrowseByAisle", () => ({
  BrowseByAisle: () => null,
}));

// ─── react-native-reanimated ─────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const makeShared = (v: unknown) => ({ value: v });
  const AnimatedView = ({ children, style }: { children?: React.ReactNode; style?: unknown }) =>
    React.createElement("rn-animated-view", { style }, children);
  const createAnimatedComponent = (C: unknown) => C;
  return {
    __esModule:          true,
    useSharedValue:      makeShared,
    useAnimatedStyle:    () => ({}),
    useAnimatedProps:    () => ({}),
    useAnimatedReaction: () => {},
    withSpring:          (v: unknown) => v,
    withRepeat:          (a: unknown) => a,
    withTiming:          (v: unknown) => v,
    runOnJS:             (fn: unknown) => fn,
    Animated: { createAnimatedComponent, View: AnimatedView },
    default:  { createAnimatedComponent, View: AnimatedView },
  };
});

// ─── react-native-gesture-handler ────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const chain = () => {
    const c: Record<string, unknown> = {};
    ["minPointers", "minDistance", "onBegin", "onUpdate", "onEnd", "numberOfTaps"].forEach(
      (m) => { c[m] = () => c; },
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

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => {
  const React = require("react");
  function make(tag: string) {
    return function SVGMock({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) {
      return React.createElement(tag, props, children);
    };
  }
  return {
    Svg:     make("svg-svg"),
    G:       make("svg-g"),
    Path:    make("svg-path"),
    Ellipse: make("svg-ellipse"),
    Circle:  make("svg-circle"),
    Rect:    make("svg-rect"),
    Text:    make("svg-text"),
    SvgUri:  make("svg-uri"),
    SvgXml:  make("svg-xml"),
  };
});

// ─── expo-asset ───────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => ({
  Asset: {
    fromModule: () => ({ downloadAsync: async () => {}, localUri: "" }),
    loadAsync:  async () => [{ hash: "test", localUri: "", uri: "" }],
  },
}));

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────

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
  SVG_VIEWBOX_W:       3592.55,
  SVG_VIEWBOX_H:       2457.41,
  SVG_ASPECT:          3592.55 / 2457.41,
  MIN_SCALE:           0.5,
  MAX_SCALE:           5,
  FIT_PADDING:         16,
  ZOOM_STOPS:          [{ scale: 1.5 }, { scale: 4 }, { scale: 10 }, { scale: 22 }, { scale: 45 }],
  parseContentViewBox: jest.fn().mockReturnValue(null),
  fitContentViewport:  jest.fn().mockReturnValue({ scale: 1, tx: 0, ty: 0 }),
  makeTileViewBox:     jest.fn().mockReturnValue("0 0 100 100"),
  computeFocusPan:     jest.fn().mockReturnValue({ tx: 0, ty: 0 }),
  tileGridSize:        jest.fn().mockReturnValue(1),
  zoomStopForScale:    jest.fn().mockReturnValue(0),
}));

// ─── AppContext ───────────────────────────────────────────────────────────────
// jest.config.js maps @/contexts/AppContext → __mocks__/contexts/AppContext.js
// which exports useApp as a jest.fn().

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

function makeAppMock(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      textSize:                   "normal" as const,
      defaultConfidenceThreshold: 50,
      themeMode:                  "system" as const,
      shelfViewEnabled:           true,
      scanSound:                  true,
      dimensionUnit:              "mm" as const,
    },
    updateSetting:         jest.fn(),
    logout:                jest.fn(),
    clearCache:            jest.fn(),
    isLoading:             false,
    isAdmin:               false,
    adminToken:            null,
    registerLogoutHandler: jest.fn(() => () => {}),
    setPendingMapFocus:    jest.fn(),
    showToast:             jest.fn(),
    setPinnedParts:        jest.fn(),
    pendingMapFocus:       null,
    textFontScale:         1.0,
    pinnedParts:           [],
    ...overrides,
  };
}

// ─── Suppress react-test-renderer deprecation warnings ────────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") || msg.includes("Warning:"))
      ) return;
      origConsoleError(msg, ...args);
    },
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  jest.clearAllMocks();
});

// ─── Subject under test ───────────────────────────────────────────────────────

import MapScreen from "../app/(tabs)/map";

// ─── Render helper ────────────────────────────────────────────────────────────

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

async function renderMapScreen(isAdmin: boolean) {
  useApp.mockReturnValue(makeAppMock({ isAdmin }));
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<MapScreen />); });
  activeTree = tree;
  await flushPromises();
  return tree;
}

function findZoneEditorButton(root: renderer.ReactTestInstance) {
  return root.findAll(
    (n) =>
      (n.type as string) === "rn-pressable" &&
      n.props.accessibilityLabel === "Open Zone Editor",
    { deep: true },
  );
}

// =============================================================================
// Zone Editor button — isAdmin guard
// =============================================================================

describe("MapScreen — Zone Editor button isAdmin guard", () => {
  it("does NOT render the Zone Editor button when isAdmin is false", async () => {
    const tree = await renderMapScreen(false);
    const buttons = findZoneEditorButton(tree.root);
    expect(buttons).toHaveLength(0);
  });

  it("renders the Zone Editor button when isAdmin is true", async () => {
    const tree = await renderMapScreen(true);
    const buttons = findZoneEditorButton(tree.root);
    expect(buttons).toHaveLength(1);
  });
});
