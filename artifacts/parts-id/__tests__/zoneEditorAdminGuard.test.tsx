/**
 * Tests that the Zone Editor button in MapScreen is guarded by both the
 * `isAdmin` flag from AppContext AND the presence of `EXPO_PUBLIC_DOMAIN`.
 *
 * The button lives inside `{isAdmin && zoneEditorUrl !== null && <View …>…</View>}` (map.tsx).
 * `zoneEditorUrl` is derived at render time from `process.env.EXPO_PUBLIC_DOMAIN`.
 *
 * Cases covered:
 *   A) isAdmin=false → button absent (domain is set — env-setup.js default)
 *   B) EXPO_PUBLIC_DOMAIN unset → button absent even for admin
 *   C) EXPO_PUBLIC_DOMAIN set + isAdmin=true → button present, calls Linking.openURL
 *   D) EXPO_PUBLIC_DOMAIN set + isAdmin=true → does NOT call Clipboard.setStringAsync
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
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
    anchors: [],
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
// Handled automatically by moduleNameMapper in jest.config.js

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── expo-asset ───────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────

jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

// ─── @/utils/mapViewport ─────────────────────────────────────────────────────

jest.mock("@/utils/mapViewport", () => require("./helpers/mapMocks").createMapViewportMock());

// ─── AppContext ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── Subject under test ───────────────────────────────────────────────────────

import MapScreen from "../app/(tabs)/map";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

/** Saved value of EXPO_PUBLIC_DOMAIN before any test tampers with it. */
const ORIGINAL_DOMAIN = process.env.EXPO_PUBLIC_DOMAIN;

let activeTree: RenderResult | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  // Restore the env var to whatever it was at suite start.
  if (ORIGINAL_DOMAIN !== undefined) {
    process.env.EXPO_PUBLIC_DOMAIN = ORIGINAL_DOMAIN;
  } else {
    delete process.env.EXPO_PUBLIC_DOMAIN;
  }
  jest.clearAllMocks();
});

async function renderMapScreen(isAdmin: boolean) {
  useApp.mockReturnValue(makeAppMock({ isAdmin }));
  const tree = await render(<MapScreen />);
  activeTree = tree;
  await flushPromises();
  return tree;
}

function findZoneEditorButton(root: RenderResult["root"]) {
  return root!.queryAll(
    (n) =>
      (n.type as string) === "rn-pressable" &&
      n.props.accessibilityLabel === "Open Zone Editor",
    { includeSelf: true },
  );
}

// =============================================================================
// A) isAdmin=false — button must not appear (domain is set by env-setup.js)
// =============================================================================

describe("MapScreen — Zone Editor button hidden when isAdmin=false", () => {
  it("does NOT render the Zone Editor button when isAdmin is false", async () => {
    process.env.EXPO_PUBLIC_DOMAIN = "test.example.com";
    const tree = await renderMapScreen(false);
    expect(findZoneEditorButton(tree.root)).toHaveLength(0);
  });
});

// =============================================================================
// B) EXPO_PUBLIC_DOMAIN unset — button absent even for admin
// =============================================================================

describe("MapScreen — Zone Editor button hidden when EXPO_PUBLIC_DOMAIN is unset", () => {
  it("does NOT render the Zone Editor button when domain is unset (isAdmin=true)", async () => {
    delete process.env.EXPO_PUBLIC_DOMAIN;
    const tree = await renderMapScreen(true);
    expect(findZoneEditorButton(tree.root)).toHaveLength(0);
  });
});

// =============================================================================
// C & D) EXPO_PUBLIC_DOMAIN set + isAdmin=true — button present, opens via Linking
// =============================================================================

describe("MapScreen — Zone Editor button with domain set and isAdmin=true", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_DOMAIN = "test.example.com";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Linking } = require("react-native") as typeof import("react-native");
    (Linking.openURL as jest.Mock).mockClear();
  });

  it("renders the Zone Editor button when domain is set and isAdmin=true", async () => {
    const tree = await renderMapScreen(true);
    expect(findZoneEditorButton(tree.root)).toHaveLength(1);
  });

  it("pressing the button calls Linking.openURL with the correct URL", async () => {
    const tree = await renderMapScreen(true);
    const [btn] = findZoneEditorButton(tree.root);
    await act(async () => { btn!.props.onPress(); });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Linking } = require("react-native") as typeof import("react-native");
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://test.example.com/__mockup/zone-editor",
    );
  });

  it("pressing the button does NOT call Clipboard.setStringAsync", async () => {
    const tree = await renderMapScreen(true);
    const [btn] = findZoneEditorButton(tree.root);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setStringAsync } = require("expo-clipboard") as { setStringAsync: jest.Mock };
    setStringAsync.mockClear();
    await act(async () => { btn!.props.onPress(); });
    expect(setStringAsync).not.toHaveBeenCalled();
  });
});
