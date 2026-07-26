/**
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
import { render, act, fireEvent } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import { makeAppMock } from "./helpers/appMocks";

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

jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

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
    anchors: [],
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
      { "data-zone-aisleId": (props.zone as { aisleId?: string })?.aisleId },
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

jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());

// ─── react-native-gesture-handler ────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => require("./helpers/mapMocks").createGestureHandlerMock());

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── expo-asset ───────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────

jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

// ─── @/utils/mapViewport ─────────────────────────────────────────────────────

jest.mock("@/utils/mapViewport", () => require("./helpers/mapMocks").createMapViewportMock());

// ─── AppContext ───────────────────────────────────────────────────────────────
// jest.config.js maps @/contexts/AppContext → __mocks__/contexts/AppContext.js
// which exports useApp as a jest.fn().

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: RenderResult | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  capturedMapViewProps        = {};
  capturedZoneActionMenuProps = {};
  capturedSummaryZone         = null;
  capturedBrowseProps         = {};
  capturedFocusEffect         = null;
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
    sectionNum:    1,
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

type Inst = ReturnType<NonNullable<RenderResult["root"]>["queryAll"]>[0];

async function renderMapScreen(appOverrides: Record<string, unknown> = {}) {
  useApp.mockReturnValue(makeAppMock(appOverrides));
  const tree = await render(<MapScreen />);
  activeTree = tree;
  await flushPromises();
  return tree;
}

function findByType(root: NonNullable<RenderResult["root"]>, type: string): Inst | null {
  const found = root.queryAll(n => (n.type as string) === type, { includeSelf: true });
  return found[0] ?? null;
}

function findAllByType(root: NonNullable<RenderResult["root"]>, type: string): Inst[] {
  return root.queryAll(n => (n.type as string) === type, { includeSelf: true });
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
    const menu = findByType(tree.root!, "zone-action-menu");
    expect(menu).not.toBeNull();
    expect(menu!.props["data-zone-aisleId"]).toBe("7");
  });

  it("passes the selected zone's id back to WarehouseMapView as selectedZoneId", async () => {
    await renderMapScreen();
    const zone = makeZone({ id: 42 });

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    expect(capturedMapViewProps.selectedZoneId).toBe(42);
  });

  it("does not show ZoneActionMenu before any zone is tapped", async () => {
    const tree = await renderMapScreen();
    const menu = findByType(tree.root!, "zone-action-menu");
    expect(menu).toBeNull();
  });
});

// =============================================================================
// 2. "GoTo Section" clears selectedZone and opens BrowseByAisle at correct aisle/parity
// =============================================================================

describe("MapScreen — GoTo Section opens BrowseByAisle with correct aisle and section", () => {
  it("replaces the map view with BrowseByAisle on onGoToSection", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone({ aisleId: "7", sectionNum: 1 });

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    // Fire GoTo Section.
    await act(async () => {
      (capturedZoneActionMenuProps.onGoToSection as () => void)();
    });

    // BrowseByAisle should now be in the tree.
    const browse = findByType(tree.root!, "browse-by-aisle");
    expect(browse).not.toBeNull();

    // BrowseByAisle receives the correct initialAisle (parsed from aisleId "7" → 7).
    expect(capturedBrowseProps.initialAisle).toBe(7);
    // ...and the sectionNumbers from the zone.
    expect(capturedBrowseProps.sectionNumbers).toEqual([1]);
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

    const menu = findByType(tree.root!, "zone-action-menu");
    expect(menu).toBeNull();
  });

  it("passes sectionNumbers=[2] when the zone has sectionNum 2", async () => {
    await renderMapScreen();
    const zone = makeZone({ aisleId: "4", sectionNum: 2 });

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });
    await act(async () => {
      (capturedZoneActionMenuProps.onGoToSection as () => void)();
    });

    expect(capturedBrowseProps.initialAisle).toBe(4);
    expect(capturedBrowseProps.sectionNumbers).toEqual([2]);
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
    expect(findByType(tree.root!, "zone-action-menu")).not.toBeNull();

    await act(async () => {
      (capturedZoneActionMenuProps.onDismiss as () => void)();
    });

    expect(findByType(tree.root!, "zone-action-menu")).toBeNull();
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
    const overlays = findAllByType(tree.root!, "rn-pressable").filter(
      (n) => n.props.accessibilityLabel === "Dismiss zone menu",
    );
    // There should be exactly one overlay pressable (not the menu's internal dismiss button
    // since ZoneActionMenu itself is mocked out).
    expect(overlays.length).toBeGreaterThan(0);

    await act(async () => { fireEvent.press(overlays[0]!); });

    expect(findByType(tree.root!, "zone-action-menu")).toBeNull();
  });

  it("does NOT navigate when the overlay is tapped", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneTap as (z: ApiWarehouseZone) => void)(zone);
    });

    const overlays = findAllByType(tree.root!, "rn-pressable").filter(
      (n) => n.props.accessibilityLabel === "Dismiss zone menu",
    );

    await act(async () => { fireEvent.press(overlays[0]!); });

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
    const zone = makeZone({ aisleId: "12", sectionNum: 0 });

    await act(async () => {
      (capturedMapViewProps.onZoneLongPress as (z: ApiWarehouseZone) => void)(zone);
    });

    // AisleSummarySheet is always rendered; its zone prop should now reflect the long-pressed zone.
    expect(capturedSummaryZone).not.toBeNull();
    expect((capturedSummaryZone as { aisleNum: number }).aisleNum).toBe(12);
  });

  it("does NOT show ZoneActionMenu after a long-press", async () => {
    const tree = await renderMapScreen();
    const zone = makeZone();

    await act(async () => {
      (capturedMapViewProps.onZoneLongPress as (z: ApiWarehouseZone) => void)(zone);
    });

    expect(findByType(tree.root!, "zone-action-menu")).toBeNull();
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

    expect(findByType(tree.root!, "zone-action-menu")).not.toBeNull();

    await act(async () => {
      (capturedMapViewProps.onPanStart as () => void)();
    });

    expect(findByType(tree.root!, "zone-action-menu")).toBeNull();
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
