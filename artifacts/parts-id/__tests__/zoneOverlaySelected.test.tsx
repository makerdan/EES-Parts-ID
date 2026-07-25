/**
 * @jest-environment node
 *
 * Regression tests: ZoneOverlayItem renders different fill colours depending on
 * the isSelected prop, allowing the warehouse map to visually distinguish which
 * zone the action menu is open for.
 *
 * Fill colour contract (non-pinned, non-cycle-mode):
 *   isSelected=true          → "rgba(0, 112, 255, 0.22)"  (selection tint)
 *   isSelected=false / unset → "rgba(0, 112, 255, 0.14)"  (standard active fill)
 *   inactive zone            → "rgba(0, 112, 255, 0.06)"  (muted fill)
 *
 * The SVG mock maps each primitive to a unique lowercase tag so the instance
 * tree carries an identifiable type string with all props forwarded.  The fill
 * value is therefore visible as svg-rect.props.fill, matching exactly what
 * ZoneOverlayItem passes to its AnimatedRect.
 *
 * Test pattern is identical to mapPin3D.test.tsx — ZoneOverlayItem is imported
 * directly from the real component file; its dependencies (reanimated, gesture-
 * handler, svg) are mocked inline below.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── react-native-svg ─────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── react-native ─────────────────────────────────────────────────────────────

jest.mock("react-native", () => ({
  Platform:        { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet:      { create: (s: unknown) => s, flatten: (s: unknown) => s },
  View:            ({ children, onLayout }: { children?: React.ReactNode; onLayout?: (e: unknown) => void }) =>
                     React.createElement("rn-view", { onLayout }, children),
  Text:            ({ children }: { children?: React.ReactNode }) => React.createElement("rn-text", {}, children),
  ActivityIndicator: () => null,
  Pressable:       ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
                     React.createElement("rn-pressable", { onPress }, children),
  PixelRatio:      { get: () => 3 },
  useColorScheme:  () => "light",
  LayoutChangeEvent: {},
  AppState:        { currentState: "active", addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

// ─── expo-asset ───────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── @/utils/apiBase ─────────────────────────────────────────────────────────
// Return an empty API_BASE so the server-hash polling setInterval in
// WarehouseMapView (guarded by `if (!API_BASE) return`) is never registered.
jest.mock("@/utils/apiBase", () => ({ API_BASE: "" }));

// ─── react-native-reanimated ──────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());

// ─── react-native-gesture-handler ────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => require("./helpers/mapMocks").createGestureHandlerMock());

// ─── @/utils/floorPlanCache ───────────────────────────────────────────────────

jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

// ─── @/utils/mapViewport ─────────────────────────────────────────────────────

jest.mock("@/utils/mapViewport", () => require("./helpers/mapMocks").createMapViewportMock());

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── Suppress react-test-renderer deprecation warning ────────────────────────

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
    },
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Subjects under test ──────────────────────────────────────────────────────

import { ZoneOverlayItem, WarehouseMapView } from "@/components/WarehouseMapView";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeZone(overrides: Partial<ApiWarehouseZone> = {}): ApiWarehouseZone {
  return {
    id:            1,
    aisleId:       "5",
    sectionNum:    0,
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

const fakeColors = {
  background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
  primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
  mutedForeground: "#64748b", destructive: "#ef4444",
  success: "#22c55e", warning: "#f59e0b", accent: "#f1f5f9", accentForeground: "#000",
} as ReturnType<typeof import("@/hooks/useColors").useColors>;

const fakeScale = { value: 1 } as import("react-native-reanimated").SharedValue<number>;

// =============================================================================
// ZoneOverlayItem — isSelected prop controls the selection fill colour
//
// The fill colour distinguishes selection state on the Rect:
//   isSelected=true  → "rgba(0, 112, 255, 0.22)"  (selection tint, thicker stroke)
//   isSelected=false → "rgba(0, 112, 255, 0.14)"  (standard active zone fill)
// =============================================================================

describe("ZoneOverlayItem — isSelected prop controls the selection fill colour", () => {
  it("isSelected=true renders the selection fill 'rgba(0, 112, 255, 0.22)' on the Rect", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={makeZone()}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isSelected={true}
        />,
      );
    });

    const rects = tree.root.findAll(
      (n) => (n.type as string) === "svg-rect",
      { deep: true },
    );
    const selectedRect = rects.find((n) => n.props.fill === "rgba(0, 112, 255, 0.22)");
    expect(selectedRect).toBeDefined();

    await act(async () => { tree.unmount(); });
  });

  it("isSelected=false renders the standard active fill 'rgba(0, 112, 255, 0.14)'", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={makeZone()}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isSelected={false}
        />,
      );
    });

    const rects = tree.root.findAll(
      (n) => (n.type as string) === "svg-rect",
      { deep: true },
    );

    const activeRect = rects.find((n) => n.props.fill === "rgba(0, 112, 255, 0.14)");
    expect(activeRect).toBeDefined();

    // Must NOT render the selected fill.
    const selectedRect = rects.find((n) => n.props.fill === "rgba(0, 112, 255, 0.22)");
    expect(selectedRect).toBeUndefined();

    await act(async () => { tree.unmount(); });
  });

  it("isSelected=true does not render the standard active fill", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={makeZone()}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isSelected={true}
        />,
      );
    });

    const rects = tree.root.findAll(
      (n) => (n.type as string) === "svg-rect",
      { deep: true },
    );
    const activeRect = rects.find((n) => n.props.fill === "rgba(0, 112, 255, 0.14)");
    expect(activeRect).toBeUndefined();

    await act(async () => { tree.unmount(); });
  });

  it("inactive zone (isInventory=false) renders the muted fill 'rgba(0, 112, 255, 0.06)'", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={makeZone({ isInventory: false })}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isSelected={false}
        />,
      );
    });

    const rects = tree.root.findAll(
      (n) => (n.type as string) === "svg-rect",
      { deep: true },
    );
    const mutedRect = rects.find((n) => n.props.fill === "rgba(0, 112, 255, 0.06)");
    expect(mutedRect).toBeDefined();

    await act(async () => { tree.unmount(); });
  });
});

// =============================================================================
// WarehouseMapView — selectedZoneId routes isSelected to exactly the matching zone
//
// When selectedZoneId=N is passed to WarehouseMapView, only the ZoneOverlayItem
// whose zone.id === N should render with the selection fill.  All other zones
// must continue to render the standard active fill.
//
// The test fires a layout event to give WarehouseMapView a non-zero containerW
// so that it exits its early-return guard and renders the SVG overlay with all
// ZoneOverlayItem instances.
// =============================================================================

describe("WarehouseMapView — selectedZoneId routes isSelected only to the matching zone", () => {
  const zoneA: ApiWarehouseZone = {
    id: 10, aisleId: "10",
    sectionNum: 0, isInventory: true,
    svgX: 0, svgY: 0, svgWidth: 300, svgHeight: 400,
    sortOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
  };
  const zoneB: ApiWarehouseZone = {
    id: 20, aisleId: "20",
    sectionNum: 0, isInventory: true,
    svgX: 400, svgY: 0, svgWidth: 300, svgHeight: 400,
    sortOrder: 1, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
  };

  it("only the zone matching selectedZoneId renders the selection fill", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <WarehouseMapView
          zones={[zoneA, zoneB]}
          zonesLoading={false}
          zonesError={false}
          onZonesRetry={jest.fn()}
          onZoneTap={jest.fn()}
          selectedZoneId={10}
        />,
      );
    });

    // Fire a layout event so containerW becomes > 0 and the zone overlay renders.
    const viewsWithLayout = tree.root.findAll(
      (n) => typeof n.props.onLayout === "function",
      { deep: true },
    );
    expect(viewsWithLayout.length).toBeGreaterThan(0);

    await act(async () => {
      viewsWithLayout[0]!.props.onLayout({
        nativeEvent: { layout: { width: 400, height: 800 } },
      });
    });

    const rects = tree.root.findAll(
      (n) => (n.type as string) === "svg-rect",
      { deep: true },
    );

    // Exactly one rect has the selection fill (zoneA, id=10).
    const selectedRects = rects.filter((n) => n.props.fill === "rgba(0, 112, 255, 0.22)");
    expect(selectedRects).toHaveLength(1);

    // The non-selected zone (zoneB, id=20) retains the standard active fill.
    const activeRects = rects.filter((n) => n.props.fill === "rgba(0, 112, 255, 0.14)");
    expect(activeRects).toHaveLength(1);

    await act(async () => { tree.unmount(); });
  });

  it("no zone gets the selection fill when selectedZoneId is undefined", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <WarehouseMapView
          zones={[zoneA, zoneB]}
          zonesLoading={false}
          zonesError={false}
          onZonesRetry={jest.fn()}
          onZoneTap={jest.fn()}
        />,
      );
    });

    const viewsWithLayout = tree.root.findAll(
      (n) => typeof n.props.onLayout === "function",
      { deep: true },
    );
    await act(async () => {
      viewsWithLayout[0]!.props.onLayout({
        nativeEvent: { layout: { width: 400, height: 800 } },
      });
    });

    const rects = tree.root.findAll(
      (n) => (n.type as string) === "svg-rect",
      { deep: true },
    );

    const selectedRects = rects.filter((n) => n.props.fill === "rgba(0, 112, 255, 0.22)");
    expect(selectedRects).toHaveLength(0);

    await act(async () => { tree.unmount(); });
  });
});
