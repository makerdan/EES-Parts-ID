/**
 * Regression tests: WarehouseMapView always opens fitted to screen on startup.
 *
 * The mount useEffect unconditionally sets pendingFit = true and immediately
 * calls applyFitIfReady.  This replaces a previous design where the viewport
 * was restored from AsyncStorage — that restore path is now removed.
 *
 * Done looks like:
 *   • The component mounts with a known contentVB and container size.
 *   • After onLayout fires, scale/translateX/translateY on the Reanimated
 *     shared values all reflect the values returned by computeFitTarget.
 *   • AsyncStorage.getItem is never called by any mount-time effect.
 *
 * Mock strategy
 * ─────────────
 * Follows the same pattern as fitButtonSnap.test.tsx (which proves applyFit
 * and applyFitIfReady snap to ZOOM_STOPS[0].scale).  Key additions here:
 *
 *   • useSharedValue returns a tracked plain object; every instance is pushed
 *     to `trackedValues` so tests can inspect post-layout `.value` mutations.
 *   • computeFitTarget is spied on (real implementation runs) so tests can
 *     read the expected { scale, tx, ty } and compare against tracked values.
 *   • AsyncStorage.getItem is a jest.fn() that starts uncalled; tests assert
 *     it remains uncalled after mount + layout.
 *   • floorPlanCache returns a pre-parsed contentViewBox (MOCK_CONTENT_VB) but
 *     empty xml/uri strings so the tile-render path is never entered, avoiding
 *     undefined-component errors caused by heavy SVG mocks.
 */

// React 19 requires IS_REACT_ACT_ENVIRONMENT = true for act() to flush
// synchronous state updates triggered by onLayout.  Without this, state
// updates escape act() and can cause "Element type is undefined" crashes.
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// ─── react-native-reanimated ──────────────────────────────────────────────────
// Shared values are tracked plain objects.  Every useSharedValue call pushes
// its returned { value } object into `trackedValues` so tests can verify that
// applyFitIfReady mutated the scale/translateX/translateY slots.

const trackedValues: Array<{ value: unknown }> = [];

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const passThrough = (v: unknown) => v;

  const AnimatedView = ({ children, ...rest }: Record<string, unknown>) =>
    React.createElement("rn-reanimated-view", rest, children);

  const createAnimatedComponent = (Component: React.ComponentType) => Component;

  return {
    // __esModule: true is required so ts-jest CJS interop takes the `default`
    // property as the default import.  Without it, Animated.View is undefined
    // and the component crashes when containerW > 0 triggers a re-render.
    __esModule: true,
    default: {
      View: AnimatedView,
      ScrollView: ({ children }: { children: React.ReactNode }) =>
        React.createElement("rn-animated-scroll", {}, children),
      createAnimatedComponent,
    },
    useSharedValue: (initial: unknown) => {
      const sv = { value: initial };
      trackedValues.push(sv);
      return sv;
    },
    useAnimatedProps: (_fn: () => unknown) => ({}),
    useAnimatedStyle: (_fn: () => unknown) => ({}),
    useAnimatedReaction: () => {},
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    withSpring: (
      value: unknown,
      _config?: unknown,
      callback?: (finished: boolean) => void,
    ) => {
      if (typeof callback === "function") callback(true);
      return value;
    },
    withTiming: passThrough,
    withRepeat: passThrough,
    Easing: { bezier: () => 0, inOut: passThrough, ease: 0, linear: 0 },
    createAnimatedComponent,
  };
});

// ─── react-native-gesture-handler ────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");

  function makeChainable() {
    const obj: Record<string, (...args: unknown[]) => typeof obj> = {};
    [
      "onBegin", "onUpdate", "onEnd", "onFinalize",
      "onTouchesDown", "onTouchesUp", "onTouchesCancelled", "onTouchesMoved",
      "minDistance", "maxDistance", "minPointers", "maxPointers",
      "averageTouches", "enableTrackpadTwoFingerGesture",
      "simultaneousWithExternalGesture", "requireExternalGestureToFail",
      "blocksExternalGesture", "withTestId", "enabled",
      "shouldCancelWhenOutside", "hitSlop", "activeCursor",
      "runOnJS", "manualActivation", "numberOfTaps", "maxDuration",
      "maxDelay", "minNumberOfPointers",
    ].forEach((m) => { obj[m] = () => obj; });
    return obj;
  }

  return {
    Gesture: {
      Pan: makeChainable,
      Pinch: makeChainable,
      Tap: makeChainable,
      LongPress: makeChainable,
      Simultaneous: (..._args: unknown[]) => makeChainable(),
      Exclusive: (..._args: unknown[]) => makeChainable(),
      Race: (..._args: unknown[]) => makeChainable(),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => {
  const React = require("react");
  const noop = () => null;
  const make = (tag: string) =>
    ({ children, ...rest }: Record<string, unknown>) =>
      React.createElement(tag, rest, children);
  return {
    default: make("svg"),
    Svg: make("svg"),
    Rect: noop,
    G: make("g"),
    Text: make("svg-text"),
    SvgUri: noop,
    SvgXml: noop,
    Path: noop,
    Ellipse: noop,
    Circle: noop,
    Defs: make("defs"),
    ClipPath: make("clip-path"),
    Use: noop,
    Symbol: noop,
  };
});

// ─── expo-asset ──────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => ({
  Asset: {
    fromModule: () => ({
      uri: "file:///mock/floor-plan.svg",
      localUri: "file:///mock/floor-plan.svg",
      downloaded: true,
      downloadAsync: jest.fn(() => Promise.resolve()),
    }),
    loadAsync: jest.fn(() =>
      Promise.resolve([{
        uri: "file:///mock/floor-plan.svg",
        localUri: "file:///mock/floor-plan.svg",
        downloaded: true,
        hash: "bundle-hash",
      }])
    ),
  },
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));

// ─── @react-native-async-storage/async-storage ───────────────────────────────
// Exposed as a trackable jest.fn().  Tests assert getItem is NEVER called by
// the mount useEffect — confirming the viewport restore from AsyncStorage path
// has been fully removed and the component always fits to screen on startup.

const mockAsyncStorageGetItem = jest.fn(() => Promise.resolve(null));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:    mockAsyncStorageGetItem,
    setItem:    jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    multiGet:   jest.fn(() => Promise.resolve([])),
  },
}));

// ─── @/utils/floorPlan ───────────────────────────────────────────────────────

jest.mock("@/utils/floorPlan", () => ({
  warmupTiles: jest.fn(() => Promise.resolve()),
  tileApiUrl:  jest.fn((z: number, x: number, y: number) =>
    `/floor-plan/tiles/${z}/${x}/${y}.png`),
}));

// ─── @/utils/tilePyramidCache ────────────────────────────────────────────────

jest.mock("@/utils/tilePyramidCache", () => ({
  cleanStaleCacheDirs: jest.fn(() => Promise.resolve()),
  fetchTile:           jest.fn(() => Promise.resolve("")),
  prefetchZoomLevel:   jest.fn(() => Promise.resolve()),
}));

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────
// Provides a pre-parsed contentViewBox so contentVBRef is populated on mount.
// xml and uri are empty strings so the tile-render path is never entered.
// The RDC34 warehouse viewBox (x:60 y:80 w:7200 h:4820) matches production
// geometry so computeFitTarget produces the real ZOOM_STOPS[0].scale value.

const MOCK_CONTENT_VB = { x: 60, y: 80, w: 7200, h: 4820 };
const MOCK_CACHED_DATA = {
  uri:          "",
  innerXml:     "",
  xml:          "",
  contentViewBox: MOCK_CONTENT_VB,
};

jest.mock("@/utils/floorPlanCache", () => ({
  getCachedHash:        jest.fn(() => "abc123"),
  getCachedData:        jest.fn(() => MOCK_CACHED_DATA),
  hasCachedData:        jest.fn(() => true),
  getIfValid:           jest.fn(() => null),
  initPersistRead:      jest.fn(() => Promise.resolve()),
  resetForServerUpdate: jest.fn(),
  setCached:            jest.fn(),
  setFallbackEmpty:     jest.fn(),
}));

// ─── import component and utilities under test (after all mocks) ──────────────

import { WarehouseMapView } from "@/components/WarehouseMapView";
import { ZOOM_STOPS } from "@/utils/mapViewport";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOOP = jest.fn();
const BASE_PROPS = {
  zones:         [],
  zonesLoading:  false,
  zonesError:    false,
  onZonesRetry:  NOOP,
  onZoneTap:     NOOP,
};

function fireOnLayout(
  renderer: TestRenderer.ReactTestRenderer,
  width: number,
  height: number,
) {
  const nodes = renderer.root.findAll(
    (n) => typeof n.props.onLayout === "function",
    { deep: true },
  );
  if (nodes.length === 0) throw new Error("No onLayout node found");
  nodes[0].props.onLayout({
    nativeEvent: { layout: { width, height, x: 0, y: 0 } },
  });
}

// ─── Per-test setup / teardown ───────────────────────────────────────────────

let computeFitTargetSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  trackedValues.length = 0;

  const fpc = require("@/utils/floorPlanCache");
  fpc.getCachedData.mockReturnValue(MOCK_CACHED_DATA);
  fpc.hasCachedData.mockReturnValue(true);
  fpc.getCachedHash.mockReturnValue("abc123");

  const mapViewport = require("@/utils/mapViewport");
  computeFitTargetSpy = jest.spyOn(mapViewport, "computeFitTarget");

  // Reset AsyncStorage mock so call counts start at zero per test.
  mockAsyncStorageGetItem.mockReset();
  mockAsyncStorageGetItem.mockReturnValue(Promise.resolve(null));

  (require("react-native").Platform as { OS: string }).OS = "ios";
});

afterEach(() => {
  computeFitTargetSpy.mockRestore();
});

// ─── Mount + layout helper ────────────────────────────────────────────────────

async function mountAndLayout(containerW: number, containerH: number) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
  });
  await act(async () => {
    fireOnLayout(renderer, containerW, containerH);
  });
  return renderer;
}

// =============================================================================
// Suite 1 — computeFitTarget is called on startup (fit path is active)
// =============================================================================

describe("startup fit — computeFitTarget is called on mount + layout", () => {
  it("phone (390×761): computeFitTarget is called after onLayout fires", async () => {
    await mountAndLayout(390, 761);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("phone (390×761): computeFitTarget is called with the cached contentViewBox", async () => {
    await mountAndLayout(390, 761);
    const call = computeFitTargetSpy.mock.calls[0] as [unknown, number, number];
    expect(call[0]).toEqual(MOCK_CONTENT_VB);
  });

  it("phone (390×761): computeFitTarget is called with the real container dimensions", async () => {
    await mountAndLayout(390, 761);
    const call = computeFitTargetSpy.mock.calls[0] as [unknown, number, number];
    expect(call[1]).toBe(390);
    expect(call[2]).toBe(761);
  });

  it("iPad (768×960): computeFitTarget is called after onLayout fires", async () => {
    await mountAndLayout(768, 960);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });
});

// =============================================================================
// Suite 2 — shared values receive computeFitTarget's output (not stale defaults)
// =============================================================================

describe("startup fit — shared values are set to computeFitTarget output", () => {
  it("phone (390×761): fit scale (ZOOM_STOPS[0].scale) is applied to a shared value", async () => {
    await mountAndLayout(390, 761);
    const fitResult = computeFitTargetSpy.mock.results[0]!.value as {
      scale: number; tx: number; ty: number;
    };
    // applyFitIfReady assigns fitResult.scale to both `scale` and `savedScale`.
    // At least one tracked shared value must now hold that value.
    const matchingScaleValues = trackedValues.filter(
      (sv) => sv.value === fitResult.scale,
    );
    expect(matchingScaleValues.length).toBeGreaterThanOrEqual(1);
  });

  it("phone (390×761): fit scale equals ZOOM_STOPS[0].scale (not the default 1)", async () => {
    await mountAndLayout(390, 761);
    const fitResult = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    expect(fitResult.scale).toBe(ZOOM_STOPS[0].scale);
    // Scale default is 1; after fit it must be the ZOOM_STOPS value.
    expect(fitResult.scale).not.toBe(1);
  });

  it("phone (390×761): fit tx is applied to a shared value (not left at 0 default)", async () => {
    await mountAndLayout(390, 761);
    const fitResult = computeFitTargetSpy.mock.results[0]!.value as {
      scale: number; tx: number; ty: number;
    };
    // applyFitIfReady assigns fitResult.tx to both `translateX` and `savedTX`.
    const matchingTxValues = trackedValues.filter(
      (sv) => sv.value === fitResult.tx,
    );
    expect(matchingTxValues.length).toBeGreaterThanOrEqual(1);
  });

  it("phone (390×761): fit ty is applied to a shared value", async () => {
    await mountAndLayout(390, 761);
    const fitResult = computeFitTargetSpy.mock.results[0]!.value as {
      scale: number; tx: number; ty: number;
    };
    const matchingTyValues = trackedValues.filter(
      (sv) => sv.value === fitResult.ty,
    );
    expect(matchingTyValues.length).toBeGreaterThanOrEqual(1);
  });

  it("iPad (768×960): fit scale is applied to a shared value", async () => {
    await mountAndLayout(768, 960);
    const fitResult = computeFitTargetSpy.mock.results[0]!.value as {
      scale: number; tx: number; ty: number;
    };
    const matchingScaleValues = trackedValues.filter(
      (sv) => sv.value === fitResult.scale,
    );
    expect(matchingScaleValues.length).toBeGreaterThanOrEqual(1);
  });

  it("phone and iPad both apply ZOOM_STOPS[0].scale (device-independent snap)", async () => {
    await mountAndLayout(390, 761);
    const phoneScale = (computeFitTargetSpy.mock.results[0]!.value as { scale: number }).scale;
    computeFitTargetSpy.mockClear();
    trackedValues.length = 0;

    await mountAndLayout(768, 960);
    const iPadScale = (computeFitTargetSpy.mock.results[0]!.value as { scale: number }).scale;

    expect(phoneScale).toBe(ZOOM_STOPS[0].scale);
    expect(iPadScale).toBe(ZOOM_STOPS[0].scale);
    expect(phoneScale).toBe(iPadScale);
  });
});

// =============================================================================
// Suite 3 — AsyncStorage.getItem is never called by the mount useEffect
// =============================================================================

describe("startup fit — no AsyncStorage.getItem call during mount", () => {
  it("phone (390×761): AsyncStorage.getItem is not called after mount + layout", async () => {
    await mountAndLayout(390, 761);
    // The old design read a saved viewport from AsyncStorage on mount.
    // The new design always fits to screen; no getItem call should occur.
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
  });

  it("iPad (768×960): AsyncStorage.getItem is not called after mount + layout", async () => {
    await mountAndLayout(768, 960);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
  });

  it("AsyncStorage.getItem stays uncalled even when contentVB arrives before layout", async () => {
    // contentVB is pre-populated via getCachedData() — simulating the case
    // where SVG cache is warm before the container size is known.
    await mountAndLayout(390, 761);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
  });
});
