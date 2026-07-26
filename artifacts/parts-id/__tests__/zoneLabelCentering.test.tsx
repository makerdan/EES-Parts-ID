/**
 * Regression tests: zone label group (aisle ID + section number) is vertically
 * centered as a symmetric block inside the zone rectangle.
 *
 * Centering contract (both cycleMode and normal mode):
 *   - Two labels: aisleY + sectionY === 2 * yCenter  (equal distances from center)
 *   - One label:  aisleY === yCenter                  (single label sits exactly on center)
 *
 * where yCenter = svgY + svgHeight / 2.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";

// ─── react-native-svg ─────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── react-native ─────────────────────────────────────────────────────────────

jest.mock("react-native", () => ({
  Platform:          { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet:        { create: (s: unknown) => s, flatten: (s: unknown) => s },
  View:              ({ children, onLayout }: { children?: React.ReactNode; onLayout?: (e: unknown) => void }) =>
                       React.createElement("rn-view", { onLayout }, children),
  Text:              ({ children }: { children?: React.ReactNode }) => React.createElement("Text", {}, children),
  ActivityIndicator: () => null,
  Pressable:         ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
                       React.createElement("rn-pressable", { onPress }, children),
  PixelRatio:        { get: () => 3 },
  useColorScheme:    () => "light",
  LayoutChangeEvent: {},
  AppState:          { currentState: "active", addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
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

// ─── Subject under test ───────────────────────────────────────────────────────

import { ZoneOverlayItem } from "@/components/WarehouseMapView";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const SVG_X      = 100;
const SVG_Y      = 200;
const SVG_WIDTH  = 300;
const SVG_HEIGHT = 400;

function makeZone(overrides: Partial<ApiWarehouseZone> = {}): ApiWarehouseZone {
  return {
    id:          1,
    aisleId:     "5",
    sectionNum:  0,
    isInventory: true,
    svgX:        SVG_X,
    svgY:        SVG_Y,
    svgWidth:    SVG_WIDTH,
    svgHeight:   SVG_HEIGHT,
    sortOrder:   1,
    createdAt:   "2024-01-01T00:00:00.000Z",
    updatedAt:   "2024-01-01T00:00:00.000Z",
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

// Derived expected values for the standard fixture zone.
//   baseFontSize = Math.max(24, Math.min(48, svgHeight / 3)) = Math.max(24, Math.min(48, 133.3)) = 48
//   lineSpacing  = 48 * 0.9 = 43.2
//   yCenter      = svgY + svgHeight / 2 = 200 + 200 = 400
const Y_CENTER = SVG_Y + SVG_HEIGHT / 2;  // 400

/**
 * Return all SVG Text nodes from a rendered tree.
 * createSvgMock() maps react-native-svg's Text component to the host tag
 * "Text" (required by test-renderer@1.x's textComponentTypes allowlist).
 * react-native's own Text component is mapped to "Text" by this test's
 * inline mock, so there is no ambiguity between the two "Text" host elements.
 */
function getSvgTextNodes(tree: Awaited<ReturnType<typeof render>>) {
  return tree.root!.queryAll(
    (n) => (n.type as string) === "Text",
    { includeSelf: true },
  );
}

// =============================================================================
// Normal mode — label group centering
// =============================================================================

describe("ZoneOverlayItem — normal mode label centering", () => {
  it("two labels: aisle and section y-values are equidistant from yCenter", async () => {
    const tree = await render(
      <ZoneOverlayItem
        zone={makeZone({ sectionNum: 3 })}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={false}
        isCounted={false}
        isSelected={false}
      />,
    );

    const texts = getSvgTextNodes(tree);
    expect(texts.length).toBeGreaterThanOrEqual(2);

    const aisleText   = texts.find((n) => n.props.fontWeight === "bold");
    const sectionText = texts.find((n) => n.props.fontWeight !== "bold" && n.props.y !== undefined && n.props.y !== aisleText?.props.y);

    expect(aisleText).toBeDefined();
    expect(sectionText).toBeDefined();

    const aisleY   = aisleText!.props.y as number;
    const sectionY = sectionText!.props.y as number;

    // Both must be on opposite sides of yCenter at equal distances.
    expect(aisleY + sectionY).toBeCloseTo(2 * Y_CENTER, 5);

    await tree.unmount();
  });

  it("one label (sectionNum=0): aisle y-value equals yCenter exactly", async () => {
    const tree = await render(
      <ZoneOverlayItem
        zone={makeZone({ sectionNum: 0 })}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={false}
        isCounted={false}
        isSelected={false}
      />,
    );

    const texts = getSvgTextNodes(tree);
    const aisleText = texts.find((n) => n.props.fontWeight === "bold");
    expect(aisleText).toBeDefined();

    const aisleY = aisleText!.props.y as number;
    expect(aisleY).toBeCloseTo(Y_CENTER, 5);

    await tree.unmount();
  });
});

// =============================================================================
// cycleMode — label group centering
// =============================================================================

describe("ZoneOverlayItem — cycleMode label centering", () => {
  it("two labels: aisle and section y-values are equidistant from yCenter", async () => {
    const tree = await render(
      <ZoneOverlayItem
        zone={makeZone({ sectionNum: 3 })}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={true}
        isCounted={false}
        isSelected={false}
      />,
    );

    const texts = getSvgTextNodes(tree);
    expect(texts.length).toBeGreaterThanOrEqual(2);

    const aisleText   = texts.find((n) => n.props.fontWeight === "bold");
    const sectionText = texts.find((n) => n.props.fontWeight !== "bold" && n.props.y !== undefined && n.props.y !== aisleText?.props.y);

    expect(aisleText).toBeDefined();
    expect(sectionText).toBeDefined();

    const aisleY   = aisleText!.props.y as number;
    const sectionY = sectionText!.props.y as number;

    expect(aisleY + sectionY).toBeCloseTo(2 * Y_CENTER, 5);

    await tree.unmount();
  });

  it("one label (sectionNum=0): aisle y-value equals yCenter exactly", async () => {
    const tree = await render(
      <ZoneOverlayItem
        zone={makeZone({ sectionNum: 0 })}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={true}
        isCounted={false}
        isSelected={false}
      />,
    );

    const texts = getSvgTextNodes(tree);
    const aisleText = texts.find((n) => n.props.fontWeight === "bold");
    expect(aisleText).toBeDefined();

    const aisleY = aisleText!.props.y as number;
    expect(aisleY).toBeCloseTo(Y_CENTER, 5);

    await tree.unmount();
  });
});
