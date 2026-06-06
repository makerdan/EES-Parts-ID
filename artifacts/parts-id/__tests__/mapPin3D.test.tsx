/**
 * @jest-environment node
 *
 * Regression test: the pinned-zone marker must render a 3D teardrop pin
 * (MapPin3D → SVG <Path>) rather than a flat circle (SVG <Circle>).
 *
 * This test guards against a revert to the old Circle-based marker.
 * MapPin3D is an exported pure SVG component; tested in isolation so
 * the setup stays lean and avoids full WarehouseMapView mount complexity.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── react-native-svg ─────────────────────────────────────────────────────────
// Each SVG primitive is mapped to a unique lowercase string tag so the
// instance tree carries an identifiable type string.  The same pattern is
// used by the react-native.js mock for RN primitives and in
// mapPinMeasureSearch.test.tsx.

jest.mock("react-native-svg", () => {
  const React = require("react");
  function make(tag: string) {
    return function SVGMock({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [k: string]: unknown;
    }) {
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

// ─── react-native ─────────────────────────────────────────────────────────────

jest.mock("react-native", () => ({
  Platform:     { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet:   { create: (s: unknown) => s, flatten: (s: unknown) => s },
  View:         ({ children }: { children?: React.ReactNode }) => React.createElement("rn-view", {}, children),
  Text:         ({ children }: { children?: React.ReactNode }) => React.createElement("rn-text", {}, children),
  ActivityIndicator: () => null,
  Pressable:    ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
                  React.createElement("rn-pressable", { onPress }, children),
  PixelRatio:   { get: () => 3 },
  useColorScheme: () => "light",
  LayoutChangeEvent: {},
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ─── expo-asset ───────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => ({
  Asset: {
    fromModule: () => ({ downloadAsync: async () => {}, localUri: "" }),
    loadAsync:  async () => [{ hash: "test", localUri: "", uri: "" }],
  },
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── react-native-reanimated ──────────────────────────────────────────────────

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
    ["minPointers", "minDistance", "onUpdate", "onEnd", "numberOfTaps"].forEach(
      (m) => { c[m] = () => c; },
    );
    return c;
  };
  return {
    Gesture: {
      Pan:         chain,
      Pinch:       chain,
      Tap:         chain,
      Simultaneous: (...args: unknown[]) => args[0],
      Exclusive:    (...args: unknown[]) => args[0],
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// ─── @/utils/floorPlanCache ───────────────────────────────────────────────────

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
  SVG_VIEWBOX_W:      7329.6001,
  SVG_VIEWBOX_H:      4997.2798,
  SVG_ASPECT:         7329.6001 / 4997.2798,
  MIN_SCALE:          0.8,
  MAX_SCALE:          50,
  FIT_PADDING:        16,
  parseContentViewBox: jest.fn().mockReturnValue(null),
  fitContentViewport:  jest.fn().mockReturnValue({ scale: 1, tx: 0, ty: 0 }),
  makeTileViewBox:     jest.fn().mockReturnValue("0 0 100 100"),
  computeFocusPan:     jest.fn().mockReturnValue({ tx: 0, ty: 0 }),
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

// ─── Subject under test ───────────────────────────────────────────────────────

import { MapPin3D, ZoneOverlayItem } from "@/components/WarehouseMapView";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeZone(overrides: Partial<ApiWarehouseZone> = {}): ApiWarehouseZone {
  return {
    id: 1,
    aisleId: "5",
    label: "05",
    sectionParity: "all",
    isInventory: true,
    svgX: 100,
    svgY: 200,
    svgWidth: 300,
    svgHeight: 400,
    sortOrder: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  } as ApiWarehouseZone;
}

const fakeColors = {
  background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
  primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
  mutedForeground: "#64748b", destructive: "#ef4444",
  success: "#22c55e", warning: "#f59e0b", accent: "#f1f5f9", accentForeground: "#000",
} as ReturnType<typeof import("@/hooks/useColors").useColors>;

// Minimal SharedValue stub matching the shape Reanimated's useSharedValue returns.
const fakeScale = { value: 1 } as import("react-native-reanimated").SharedValue<number>;

// =============================================================================
// MapPin3D — SVG element regression
// =============================================================================

describe("MapPin3D — renders Path, not Circle", () => {
  it("produces at least one svg-path host element (the teardrop body)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" />,
      );
    });

    const paths = tree.root.findAll(
      (n) => (n.type as string) === "svg-path",
      { deep: true },
    );
    expect(paths.length).toBeGreaterThan(0);

    await act(async () => { tree.unmount(); });
  });

  it("does not render any svg-circle host element (regression: was Circle before MapPin3D)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" />,
      );
    });

    const circles = tree.root.findAll(
      (n) => (n.type as string) === "svg-circle",
      { deep: true },
    );
    expect(circles).toHaveLength(0);

    await act(async () => { tree.unmount(); });
  });

  it("renders shadow and gloss ellipses alongside the path (full 3D pin structure)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MapPin3D cx={50} cy={80} size={15} fill="#8b5cf6" stroke="#6d28d9" />,
      );
    });

    // MapPin3D renders two Ellipses: drop-shadow below the tip and
    // gloss highlight inside the ball.
    const ellipses = tree.root.findAll(
      (n) => (n.type as string) === "svg-ellipse",
      { deep: true },
    );
    expect(ellipses.length).toBe(2);

    await act(async () => { tree.unmount(); });
  });
});

// =============================================================================
// MapPin3D — colour-coding contract
//
// These tests pin the exact fill values so a refactor that swaps amber/purple
// constants is caught immediately.  The SVG mock passes all props through, so
// node.props.fill reflects exactly what MapPin3D passes to <Path>.
// =============================================================================

describe("MapPin3D — colour-coding contract", () => {
  it("amber primary result: the teardrop Path carries fill='#f59e0b'", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" />,
      );
    });

    const paths = tree.root.findAll(
      (n) => (n.type as string) === "svg-path",
      { deep: true },
    );
    expect(paths.length).toBeGreaterThan(0);
    const teardrop = paths.find((n) => n.props.fill === "#f59e0b");
    expect(teardrop).toBeDefined();

    await act(async () => { tree.unmount(); });
  });

  it("purple related-size result: the teardrop Path carries fill='#8b5cf6'", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MapPin3D cx={50} cy={80} size={15} fill="#8b5cf6" stroke="#6d28d9" />,
      );
    });

    const paths = tree.root.findAll(
      (n) => (n.type as string) === "svg-path",
      { deep: true },
    );
    expect(paths.length).toBeGreaterThan(0);
    const teardrop = paths.find((n) => n.props.fill === "#8b5cf6");
    expect(teardrop).toBeDefined();

    await act(async () => { tree.unmount(); });
  });
});

// =============================================================================
// ZoneOverlayItem — pinned zone uses MapPin3D (Path), not Circle
//
// These tests verify the actual integration point: when a zone is pinned,
// ZoneOverlayItem renders MapPin3D which produces an svg-path host element.
// A revert to a Circle-based marker would produce svg-circle instead and
// break both tests below, catching the regression at the zone-overlay level.
// =============================================================================

describe("ZoneOverlayItem — pinned zone renders svg-path not svg-circle", () => {
  it("a pinned zone with no section data renders at least one svg-path (MapPin3D fallback)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={makeZone()}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          cycleLocked={false}
          isCounted={false}
          isPinned={true}
        />,
      );
    });

    const paths = tree.root.findAll(
      (n) => (n.type as string) === "svg-path",
      { deep: true },
    );
    expect(paths.length).toBeGreaterThan(0);

    await act(async () => { tree.unmount(); });
  });

  it("a pinned zone does not render any svg-circle (regression: was Circle before MapPin3D)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={makeZone()}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          cycleLocked={false}
          isCounted={false}
          isPinned={true}
        />,
      );
    });

    const circles = tree.root.findAll(
      (n) => (n.type as string) === "svg-circle",
      { deep: true },
    );
    expect(circles).toHaveLength(0);

    await act(async () => { tree.unmount(); });
  });

  it("a pinned zone with section data renders svg-path for each section marker", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={makeZone()}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          cycleLocked={false}
          isCounted={false}
          isPinned={true}
          pinnedSections={[20, 60]}
        />,
      );
    });

    // Two sections → two MapPin3D instances → at least two svg-path elements.
    const paths = tree.root.findAll(
      (n) => (n.type as string) === "svg-path",
      { deep: true },
    );
    expect(paths.length).toBeGreaterThanOrEqual(2);

    const circles = tree.root.findAll(
      (n) => (n.type as string) === "svg-circle",
      { deep: true },
    );
    expect(circles).toHaveLength(0);

    await act(async () => { tree.unmount(); });
  });

  it("a pinned zone passes the amber palette (#f59e0b fill) to its MapPin3D", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={makeZone()}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          cycleLocked={false}
          isCounted={false}
          isPinned={true}
        />,
      );
    });

    const paths = tree.root.findAll(
      (n) => (n.type as string) === "svg-path",
      { deep: true },
    );
    const amberPath = paths.find((n) => n.props.fill === "#f59e0b");
    expect(amberPath).toBeDefined();

    await act(async () => { tree.unmount(); });
  });
});
