/**
 * @jest-environment node
 *
 * Regression tests for the fill-opacity animation in ZoneOverlayItem.
 *
 * The useEffect at WarehouseMapView.tsx ~line 282 animates fillOpacitySV 0→1
 * (via withTiming) when a zone first receives a pin (isPinned transitions
 * false→true).  It must NOT fire again on subsequent re-renders while the zone
 * remains pinned, and must NOT fire at all when the component mounts with
 * isPinned already true (e.g. restored from a saved search).
 *
 * Strategy
 * --------
 * withTiming is exposed as jest.fn() from the Reanimated mock so calls can be
 * counted and inspected.  ZoneOverlayItem is mounted via react-test-renderer;
 * renderer.update() drives prop changes without unmounting, and act() flushes
 * the useEffect queue after each render.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── react-native-svg ─────────────────────────────────────────────────────────

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
//
// withTiming is a jest.fn() so tests can assert whether the fill-opacity
// animation was triggered and with what arguments.

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
    withTiming:           jest.fn((v: unknown) => v),
    runOnJS:              (fn: unknown) => fn,
    cancelAnimation:      () => {},
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
  SVG_VIEWBOX_W:       7329.6001,
  SVG_VIEWBOX_H:       4997.2798,
  SVG_ASPECT:          7329.6001 / 4997.2798,
  MIN_SCALE:           0.8,
  MAX_SCALE:           50,
  FIT_PADDING:         16,
  ZOOM_STOPS:          [{ scale: 1.5 }, { scale: 4 }, { scale: 10 }, { scale: 22 }, { scale: 45 }],
  parseContentViewBox: jest.fn().mockReturnValue(null),
  fitContentViewport:  jest.fn().mockReturnValue({ scale: 1, tx: 0, ty: 0 }),
  makeTileViewBox:     jest.fn().mockReturnValue("0 0 100 100"),
  computeFocusPan:     jest.fn().mockReturnValue({ tx: 0, ty: 0 }),
  tileGridSize:        jest.fn().mockReturnValue(1),
  zoomStopForScale:    jest.fn().mockReturnValue(0),
}));

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

// ─── Subject under test ───────────────────────────────────────────────────────

import { ZoneOverlayItem } from "@/components/WarehouseMapView";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeZone(overrides: Partial<ApiWarehouseZone> = {}): ApiWarehouseZone {
  return {
    id: 1,
    aisleId: "5",
    label: "05",
    sectionNum: 0,
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

const fakeScale = { value: 1 } as import("react-native-reanimated").SharedValue<number>;

// ─── Access the withTiming spy ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withTimingMock = (require("react-native-reanimated") as { withTiming: jest.Mock }).withTiming;

// =============================================================================
// Fill-opacity animation — new pin placement
// =============================================================================

describe("ZoneOverlayItem fill-opacity animation — new pin placement", () => {
  let tree!: renderer.ReactTestRenderer;
  const zone = makeZone();

  beforeEach(() => {
    withTimingMock.mockClear();
  });

  afterEach(async () => {
    await act(async () => { tree.unmount(); });
  });

  it("calls withTiming(1, { duration: 250 }) when isPinned transitions false→true", async () => {
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={false}
        />,
      );
    });

    // No animation should have fired while the zone is unpinned.
    expect(withTimingMock).not.toHaveBeenCalled();

    // Transition to pinned — the fill-opacity animation should fire.
    await act(async () => {
      tree.update(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={true}
        />,
      );
    });

    expect(withTimingMock).toHaveBeenCalledWith(1, { duration: 250 });
  });

  it("animates to opacity 1 (not 0) — fill-opacity ends at fully visible", async () => {
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={false}
        />,
      );
    });

    await act(async () => {
      tree.update(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={true}
        />,
      );
    });

    // The first argument to withTiming is the target value — must be 1, not 0.
    const firstCall = withTimingMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![0]).toBe(1);
  });
});

// =============================================================================
// Fill-opacity animation — already-pinned zone on mount (no animation)
// =============================================================================

describe("ZoneOverlayItem fill-opacity animation — already pinned on mount", () => {
  let tree!: renderer.ReactTestRenderer;
  const zone = makeZone();

  beforeEach(() => {
    withTimingMock.mockClear();
  });

  afterEach(async () => {
    await act(async () => { tree.unmount(); });
  });

  it("does NOT call withTiming when the zone is already pinned on first render", async () => {
    // Simulates a restored search result where isPinned=true from the start.
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={true}
        />,
      );
    });

    expect(withTimingMock).not.toHaveBeenCalled();
  });

  it("does NOT call withTiming when isVariantPinned is already true on first render", async () => {
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isVariantPinned={true}
        />,
      );
    });

    expect(withTimingMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Fill-opacity animation — no re-animation on subsequent re-renders
// =============================================================================

describe("ZoneOverlayItem fill-opacity animation — no re-animation while already pinned", () => {
  let tree!: renderer.ReactTestRenderer;
  const zone = makeZone();

  beforeEach(() => {
    withTimingMock.mockClear();
  });

  afterEach(async () => {
    await act(async () => { tree.unmount(); });
  });

  it("does NOT call withTiming again when re-rendered with isPinned still true", async () => {
    // Mount unpinned.
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={false}
        />,
      );
    });

    // First pin — animation fires once.
    await act(async () => {
      tree.update(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={true}
        />,
      );
    });

    // Clear the count so we only measure subsequent renders.
    withTimingMock.mockClear();

    // Re-render with a different prop (e.g. binLabel arrives) while still pinned.
    await act(async () => {
      tree.update(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={true}
          binLabel="17-06-204"
        />,
      );
    });

    expect(withTimingMock).not.toHaveBeenCalled();
  });

  it("does NOT call withTiming again on a second unrelated re-render while pinned", async () => {
    // Mount pinned from the start (e.g. search result page restore).
    await act(async () => {
      tree = renderer.create(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={true}
        />,
      );
    });

    withTimingMock.mockClear();

    // Trigger an unrelated re-render (scale object identity stays the same).
    await act(async () => {
      tree.update(
        <ZoneOverlayItem
          zone={zone}
          scale={fakeScale}
          colors={fakeColors}
          onZoneTap={jest.fn()}
          cycleMode={false}
          isCounted={false}
          isPinned={true}
          pinnedSections={[10, 20]}
        />,
      );
    });

    expect(withTimingMock).not.toHaveBeenCalled();
  });
});
