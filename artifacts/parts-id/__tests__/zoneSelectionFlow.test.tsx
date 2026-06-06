/**
 * @jest-environment node
 *
 * Tests for the Zone action menu selection and navigation flow in MapScreen.
 *
 * Covered:
 *  1. Tapping a zone (via captured onZoneTap) sets selectedZone and renders ZoneActionMenu.
 *  2. "GoTo Section" (onGoToSection) clears selectedZone and opens BrowseByAisle at the
 *     correct initialAisle and sectionParity.
 *  3. The dismiss button (onDismiss from ZoneActionMenu) clears selectedZone without navigating.
 *  4. The transparent dismiss overlay (rn-pressable with "Dismiss zone menu" label) clears
 *     selectedZone without navigating.
 *  5. Long-pressing a zone continues to open AisleSummarySheet (unchanged behaviour).
 *
 * ZoneOverlayItem selection-fill rendering is tested in zoneOverlaySelected.test.tsx.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── expo-router ──────────────────────────────────────────────────────────────

const mockRouterNavigate = jest.fn();
const mockRouterPush    = jest.fn();
let capturedFocusEffect: (() => (() => void) | void) | null = null;

jest.mock("expo-router", () => ({
  router: { navigate: mockRouterNavigate, push: mockRouterPush },
  useFocusEffect: (cb: () => void) => { capturedFocusEffect = cb; },
  useRouter: () => ({ navigate: mockRouterNavigate, push: mockRouterPush }),
}));

// ─── expo-screen-orientation ─────────────────────────────────────────────────

jest.mock("expo-screen-orientation", () => ({
  unlockAsync: jest.fn().mockResolvedValue(undefined),
  lockAsync:   jest.fn().mockResolvedValue(undefined),
  OrientationLock: { PORTRAIT_UP: "PORTRAIT_UP" },
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
    primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
    mutedForeground: "#64748b", destructive: "#ef4444",
    success: "#22c55e", warning: "#f59e0b", accent: "#f1f5f9", accentForeground: "#000",
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
  FUSE_CACHE_KEY:             "fuse_cache",
  FUSE_CACHE_SYNCED_AT_KEY:   "fuse_synced_at",
  getFuseCacheSyncedAt:       jest.fn().mockResolvedValue(Date.now()),
  FUSE_SYNC_MAX_AGE_MS:       Infinity,
  lookupByBarcodeOffline:     jest.fn().mockResolvedValue(null),
}));

// ─── @/hooks/useWarehouseZones ───────────────────────────────────────────────

const mockRefetchZones = jest.fn();
jest.mock("@/hooks/useWarehouseZones", () => ({
  useWarehouseZones: jest.fn(() => ({
    zones:   [],
    loading: false,
    error:   false,
    refetch: mockRefetchZones,
  })),
}));

// ─── @/components/WarehouseMapView — capture props ──────────────────────────
// The mock stores the latest set of props so tests can call callbacks directly.

let capturedMapViewProps: Record<string, unknown> = {};

jest.mock("@/components/WarehouseMapView", () => ({
  WarehouseMapView: (props: Record<string, unknown>) => {
    capturedMapViewProps = props;
    return null;
  },
}));

// ─── @/components/ZoneActionMenu — capture props ─────────────────────────────
// Render as identifiable host elements so the tree search can confirm presence.

let capturedZoneActionMenuProps: Record<string, unknown> = {};

jest.mock("@/components/ZoneActionMenu", () => ({
  ZoneActionMenu: (props: Record<string, unknown>) => {
    const React = require("react");
    capturedZoneActionMenuProps = props;
    return React.createElement(
      "zone-action-menu",
      { "data-zone-label": (props.zone as { label?: string })?.label },
    );
  },
}));

// ─── @/components/AisleSummarySheet — capture zone prop ──────────────────────

let capturedSummaryZone: unknown = null;

jest.mock("@/components/AisleSummarySheet", () => ({
  AisleSummarySheet: (props: { zone: unknown }) => {
    capturedSummaryZone = props.zone;
    return null;
  },
}));

// ─── @/components/BrowseByAisle — capture props ──────────────────────────────

let capturedBrowseProps: Record<string, unknown> = {};

jest.mock("@/components/BrowseByAisle", () => ({
  BrowseByAisle: (props: Record<string, unknown>) => {
    const React = require("react");
    capturedBrowseProps = props;
    return React.createElement("browse-by-aisle", {});
  },
}));

// ─── react-native-reanimated ─────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const makeShared = (v: unknown) => ({ value: v });
  const AnimatedView = ({ children, style }: { children?: React.ReactNode; style?: unknown }) =>
    React.createElement("rn-animated-view", { style }, children);
  const createAnimatedComponent = (C: unknown) => C;
  return {
    __esModule:           true,
    useSharedValue:       makeShared,
    useAnimatedStyle:     () => ({}),
    useAnimatedProps:     () => ({}),
    useAnimatedReaction:  () => {},
    withSpring:           (v: unknown) => v,
    withRepeat:           (a: unknown) => a,
    withTiming:           (v: unknown) => v,
    runOnJS:              (fn: unknown) => fn,
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
  parseContentViewBox: jest.fn().mockReturnValue(null),
  fitContentViewport:  jest.fn().mockReturnValue({ scale: 1, tx: 0, ty: 0 }),
  makeTileViewBox:     jest.fn().mockReturnValue("0 0 100 100"),
  computeFocusPan:     jest.fn().mockReturnValue({ tx: 0, ty: 0 }),
}));

// ─── AppContext ───────────────────────────────────────────────────────────────
// jest.config.js maps @/contexts/AppContext → __mocks__/contexts/AppContext.js
// which exports useApp as a jest.fn().

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

const mockSetPinnedParts     = jest.fn();
const mockShowToast          = jest.fn();
const mockSetPendingMapFocus = jest.fn();

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
    setPendingMapFocus:    mockSetPendingMapFocus,
    showToast:             mockShowToast,
    setPinnedParts:        mockSetPinnedParts,
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
      if (typeof msg === "string" && (
        msg.includes("react-test-renderer is deprecated") ||
        msg.includes("Warning:")
      )) return;
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
  capturedMapViewProps       = {};
  capturedZoneActionMenuProps = {};
  capturedSummaryZone        = null;
  capturedBrowseProps        = {};
  capturedFocusEffect        = null;
  jest.clearAllMocks();
});

// ─── Subjects under test ──────────────────────────────────────────────────────

import MapScreen from "../app/(tabs)/map";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeZone(overrides: Partial<ApiWarehouseZone> = {}): ApiWarehouseZone {
  return {
    id:            7,
    aisleId:       "7",
    label:         "07",
    sectionParity: "odd",
    isInventory:   true,
    svgX:          100,
    svgY:          200,
    svgWidth:      300,
    svgHeight:     400,
    sortOrder:     1,
    createdAt:     "2024-01-01T00:00:00.000Z",
    updatedAt:     "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

// ─── Render helper ────────────────────────────────────────────────────────────

type Inst = renderer.ReactTestInstance;

async function renderMapScreen(appOverrides: Record<string, unknown> = {}) {
  useApp.mockReturnValue(makeAppMock(appOverrides));
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<MapScreen />); });
  activeTree = tree;
  await flushPromises();
  return tree;
}

function findByType(root: Inst, type: string): Inst | null {
  const found = root.findAll(n => (n.type as string) === type, { deep: true });
  return found[0] ?? null;
}

function findAllByType(root: Inst, type: string): Inst[] {
  return root.findAll(n => (n.type as string) === type, { deep: true });
}

// =============================================================================
// 1. Tapping a zone in selectMode sets selectedZone and shows ZoneActionMenu
// =============================================================================

describe("MapScreen — zone tap sets selectedZone and shows ZoneActionMenu", () => {
  it("renders ZoneActionMenu with the tapped zone after onZoneTap fires", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    // The WarehouseMapView mock captures the onZoneTap callback.
    // Calling it simulates what WarehouseMapView does when a zone is tapped in selectMode.
    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    // ZoneActionMenu should now be in the tree.
    const menu = findByType(tree.root, "zone-action-menu");
    expect(menu).not.toBeNull();
    expect(menu!.props["data-zone-label"]).toBe("07");
  });

  it("passes the selected zone's id back to WarehouseMapView as selectedZoneId", async () => {
    await renderMapScreen();
    const zone = makeZone({ id: 42, label: "42" });

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    expect(capturedMapViewProps.selectedZoneId).toBe(42);
  });

  it("does not show ZoneActionMenu before any zone is tapped", async () => {
    const tree = await renderMapScreen();
    const menu = findByType(tree.root, "zone-action-menu");
    expect(menu).toBeNull();
  });
});

// =============================================================================
// 2. "GoTo Section" clears selectedZone and opens BrowseByAisle at correct aisle/parity
// =============================================================================

describe("MapScreen — GoTo Section opens BrowseByAisle with correct aisle and parity", () => {
  it("replaces the map view with BrowseByAisle on onGoToSection", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone({ aisleId: "7", sectionParity: "odd" });

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    // Fire GoTo Section.
    await act(async () => {
      (capturedZoneActionMenuProps.onGoToSection as () => void)();
    });

    // BrowseByAisle should now be in the tree.
    const browse = findByType(tree.root, "browse-by-aisle");
    expect(browse).not.toBeNull();

    // BrowseByAisle receives the correct initialAisle (parsed from aisleId "7" → 7).
    expect(capturedBrowseProps.initialAisle).toBe(7);
    // ...and the sectionParity from the zone.
    expect(capturedBrowseProps.sectionParity).toBe("odd");
  });

  it("clears the selected zone so ZoneActionMenu is no longer visible after navigation", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });
    await act(async () => {
      (capturedZoneActionMenuProps.onGoToSection as () => void)();
    });

    const menu = findByType(tree.root, "zone-action-menu");
    expect(menu).toBeNull();
  });

  it("passes sectionParity='even' when the zone has even parity", async () => {
    await renderMapScreen();
    const zone = makeZone({ aisleId: "4", sectionParity: "even" });

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });
    await act(async () => {
      (capturedZoneActionMenuProps.onGoToSection as () => void)();
    });

    expect(capturedBrowseProps.initialAisle).toBe(4);
    expect(capturedBrowseProps.sectionParity).toBe("even");
  });

  it("does NOT call the router (no push/navigate) when going to a section", async () => {
    await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });
    await act(async () => {
      (capturedZoneActionMenuProps.onGoToSection as () => void)();
    });

    expect(mockRouterNavigate).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. Dismiss button (onDismiss) clears selectedZone without navigating
// =============================================================================

describe("MapScreen — dismiss button clears selectedZone without navigating", () => {
  it("hides ZoneActionMenu when onDismiss fires", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    // Confirm the menu is showing.
    expect(findByType(tree.root, "zone-action-menu")).not.toBeNull();

    await act(async () => {
      (capturedZoneActionMenuProps.onDismiss as () => void)();
    });

    expect(findByType(tree.root, "zone-action-menu")).toBeNull();
  });

  it("does NOT navigate when onDismiss fires", async () => {
    await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });
    await act(async () => {
      (capturedZoneActionMenuProps.onDismiss as () => void)();
    });

    expect(mockRouterNavigate).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("clears selectedZoneId on WarehouseMapView after dismiss", async () => {
    await renderMapScreen();
    const zone = makeZone({ id: 9 });

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });
    expect(capturedMapViewProps.selectedZoneId).toBe(9);

    await act(async () => {
      (capturedZoneActionMenuProps.onDismiss as () => void)();
    });
    expect(capturedMapViewProps.selectedZoneId).toBeUndefined();
  });
});

// =============================================================================
// 4. Outside-tap (dismiss overlay pressable) clears selectedZone without navigating
// =============================================================================

describe("MapScreen — outside-tap overlay clears selectedZone without navigating", () => {
  it("hides ZoneActionMenu when the dismiss overlay is pressed", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    // Find the transparent dismiss overlay pressable (it has accessibilityLabel "Dismiss zone menu"
    // and is a sibling of ZoneActionMenu, distinct from the ZoneActionMenu's own dismiss button).
    const overlays = findAllByType(tree.root, "rn-pressable").filter(
      (n) => n.props.accessibilityLabel === "Dismiss zone menu",
    );
    // There should be exactly one overlay pressable (not the menu's internal dismiss button
    // since ZoneActionMenu itself is mocked out).
    expect(overlays.length).toBeGreaterThan(0);

    await act(async () => { overlays[0].props.onPress(); });

    expect(findByType(tree.root, "zone-action-menu")).toBeNull();
  });

  it("does NOT navigate when the overlay is tapped", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    const overlays = findAllByType(tree.root, "rn-pressable").filter(
      (n) => n.props.accessibilityLabel === "Dismiss zone menu",
    );

    await act(async () => { overlays[0].props.onPress(); });

    expect(mockRouterNavigate).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 5. Long-press continues to open AisleSummarySheet (unchanged behaviour)
// =============================================================================

describe("MapScreen — long-press opens AisleSummarySheet (not zone action menu)", () => {
  it("sets the summaryZone (AisleSummarySheet receives the zone) on long-press", async () => {
    await renderMapScreen();
    const zone = makeZone({ aisleId: "12", label: "12", sectionParity: "all" });

    await act(async () => {
      (capturedMapViewProps.onZoneLongPress as (z: ApiWarehouseZone) => void)(zone);
    });

    // AisleSummarySheet is always rendered; its zone prop should now reflect the long-pressed zone.
    expect(capturedSummaryZone).not.toBeNull();
    expect((capturedSummaryZone as { aisleNum: number }).aisleNum).toBe(12);
    expect((capturedSummaryZone as { label: string }).label).toBe("12");
  });

  it("does NOT show ZoneActionMenu after a long-press", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneLongPress as (z: ApiWarehouseZone) => void)(zone);
    });

    expect(findByType(tree.root, "zone-action-menu")).toBeNull();
  });

  it("does NOT navigate after a long-press", async () => {
    await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneLongPress as (z: ApiWarehouseZone) => void)(zone);
    });

    expect(mockRouterNavigate).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 6. Pan-gesture on the map dismisses the zone action menu
// =============================================================================

describe("MapScreen — map pan-start clears selectedZone", () => {
  it("hides ZoneActionMenu when onPanStart fires", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    expect(findByType(tree.root, "zone-action-menu")).not.toBeNull();

    await act(async () => {
      (capturedMapViewProps.onPanStart as () => void)();
    });

    expect(findByType(tree.root, "zone-action-menu")).toBeNull();
  });

  it("does NOT navigate when onPanStart fires", async () => {
    await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });
    await act(async () => {
      (capturedMapViewProps.onPanStart as () => void)();
    });

    expect(mockRouterNavigate).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

