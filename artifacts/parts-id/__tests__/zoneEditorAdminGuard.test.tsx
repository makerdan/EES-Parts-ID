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
import { makeAppMock } from "./helpers/appMocks";

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
