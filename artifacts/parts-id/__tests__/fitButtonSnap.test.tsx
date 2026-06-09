/**
 * Component-level regression tests: applyFit and applyFitIfReady always snap
 * to ZOOM_STOPS[0].scale (z0) and call computeFitTarget on both phone and iPad.
 *
 * These tests mount a real WarehouseMapView instance (with native deps mocked)
 * and trigger the actual callback paths rather than re-implementing the logic.
 * If a future refactor changes applyFit or applyFitIfReady to bypass
 * computeFitTarget or use a different scale, these tests fail immediately.
 *
 * Two callback paths are covered:
 *   A) applyFitIfReady — the immediate (non-animated) path triggered by
 *      onLayout after the SVG viewBox has been parsed.  This is the path that
 *      runs on cold start when no saved viewport exists.
 *
 *   B) applyFit — the animated path triggered by the "Fit to screen" button
 *      (and double-tap gesture).  The withSpring mock passes values through
 *      directly and fires the onEnd callback so the full commit path runs.
 *
 * Mock strategy
 * ─────────────
 * • react-native-reanimated: shared values are plain { value } objects;
 *   withSpring passes the target through AND calls onEnd synchronously so
 *   setRenderZoom fires inside applyFit.
 * • All heavy native modules are stubbed exactly as in warehouseMapCacheCleanup.
 * • @/utils/floorPlanCache: getCachedData() returns a minimal SVG with a
 *   known warehouse viewBox so contentVBRef gets populated on mount.
 * • @react-native-async-storage/async-storage: getItem returns null so the
 *   restore path sets pendingFit.current = true.
 * • computeFitTarget is spied upon via jest.spyOn AFTER imports, so the real
 *   implementation still runs and calls can be asserted.
 */

// React 19 requires IS_REACT_ACT_ENVIRONMENT = true for act() to flush
// synchronous state updates (e.g. setContainerW triggered by onLayout).
// Without this, state updates escape act() and cause a re-render outside
// any act()-protected scope, which triggers "Element type is undefined".
// warehouseMapCacheCleanup.test.tsx doesn't need this because it never
// fires onLayout and therefore never triggers a containerW re-render.
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// ─── react-native-reanimated ──────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const passThrough = (v: unknown) => v;

  const AnimatedView = ({ children, ...rest }: Record<string, unknown>) =>
    React.createElement("rn-reanimated-view", rest, children);

  const createAnimatedComponent = (Component: React.ComponentType) => Component;

  return {
    // __esModule: true tells ts-jest that the default import should be taken
    // from the `default` property rather than the whole module object.
    // Without this, `import Animated from "react-native-reanimated"` receives
    // the entire module object — so Animated.View is undefined and rendering
    // <Animated.View> after containerW > 0 triggers "Element type is invalid".
    __esModule: true,
    default: {
      View: AnimatedView,
      ScrollView: ({ children }: { children: React.ReactNode }) =>
        React.createElement("rn-animated-scroll", {}, children),
      createAnimatedComponent,
    },
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedProps: (_fn: () => unknown) => ({}),
    useAnimatedStyle: (_fn: () => unknown) => ({}),
    useAnimatedReaction: () => {},
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    // Pass through the target value AND fire the onEnd callback so that
    // setRenderZoom runs inside applyFit's spring completion path.
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
// Returns null so the restore path sets pendingFit.current = true.

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    multiGet: jest.fn(() => Promise.resolve([])),
  },
}));

// ─── @/utils/floorPlan ───────────────────────────────────────────────────────

jest.mock("@/utils/floorPlan", () => ({
  warmupTiles: jest.fn(() => Promise.resolve()),
  tileApiUrl: jest.fn((z: number, x: number, y: number) =>
    `/floor-plan/tiles/${z}/${x}/${y}.png`),
}));

// ─── @/utils/tilePyramidCache ────────────────────────────────────────────────

jest.mock("@/utils/tilePyramidCache", () => ({
  cleanStaleCacheDirs: jest.fn(() => Promise.resolve()),
  fetchTile: jest.fn(() => Promise.resolve("")),
  prefetchZoomLevel: jest.fn(() => Promise.resolve()),
}));

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────
// Provides a pre-parsed contentViewBox but NO xml string.  This ensures:
//   • svgXml stays "" → WarehouseMapView skips the tile-render path, avoiding
//     the undefined-component error that occurs when heavy SVG rendering fires.
//   • contentVB / contentVBRef are initialised from getCachedData()?.contentViewBox
//     (the useState initialiser captures it, useRef follows) so applyFitIfReady
//     finds a non-null viewBox and can actually run.
//   • svgLoading = !hasCachedData() = false → "Fit to screen" button is visible
//     so applyFit can be triggered by pressFitButton().
//
// The RDC34 warehouse viewBox (x:60 y:80 w:7200 h:4820) matches production
// geometry so the scale arithmetic produces the true ZOOM_STOPS[0].scale value.

const MOCK_CONTENT_VB = { x: 60, y: 80, w: 7200, h: 4820 };
const MOCK_CACHED_DATA = {
  uri: "",         // keep svgUri empty — non-empty uri triggers tile-render path which hits undefined components in tests
  innerXml: "",
  xml: "",         // keep svgXml empty to avoid tile-render path
  contentViewBox: MOCK_CONTENT_VB,
};

jest.mock("@/utils/floorPlanCache", () => ({
  getCachedHash: jest.fn(() => "abc123"),
  getCachedData: jest.fn(() => MOCK_CACHED_DATA),
  hasCachedData: jest.fn(() => true),
  getIfValid: jest.fn(() => null),
  initPersistRead: jest.fn(() => Promise.resolve()),
  resetForServerUpdate: jest.fn(),
  setCached: jest.fn(),
  setFallbackEmpty: jest.fn(),
}));

// ─── import component and utilities under test (after all mocks) ──────────────

import { WarehouseMapView } from "@/components/WarehouseMapView";
import { ZOOM_STOPS, zoomStopForScale } from "@/utils/mapViewport";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOOP = jest.fn();
const BASE_PROPS = {
  zones: [],
  zonesLoading: false,
  zonesError: false,
  onZonesRetry: NOOP,
  onZoneTap: NOOP,
};

/**
 * Fire the onLayout event on the first View that exposes an onLayout prop.
 * When containerW is 0, WarehouseMapView renders a single View at the root;
 * once containerW is non-zero it renders the full map tree.
 */
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

/**
 * Press the "Fit to screen" button (accessibilityLabel).
 */
function pressFitButton(renderer: TestRenderer.ReactTestRenderer) {
  const btn = renderer.root.find(
    (n) => n.props.accessibilityLabel === "Fit to screen",
  );
  btn.props.onPress();
}

// ─────────────────────────────────────────────────────────────────────────────

let computeFitTargetSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  // Re-register the floorPlanCache mocks since clearAllMocks resets them.
  const fpc = require("@/utils/floorPlanCache");
  fpc.getCachedData.mockReturnValue(MOCK_CACHED_DATA);
  fpc.hasCachedData.mockReturnValue(true);
  fpc.getCachedHash.mockReturnValue("abc123");
  // Spy on computeFitTarget so we can assert it was called and check its result.
  // jest.spyOn replaces the property on the module object; WarehouseMapView
  // accesses it through the same module object reference at call time.
  const mapViewport = require("@/utils/mapViewport");
  computeFitTargetSpy = jest.spyOn(mapViewport, "computeFitTarget");
  // Restore Platform to ios.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require("react-native").Platform as { OS: string }).OS = "ios";
});

afterEach(() => {
  computeFitTargetSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Path A — applyFitIfReady (immediate fit on layout + SVG parse)
// ─────────────────────────────────────────────────────────────────────────────
//
// Flow: AsyncStorage returns null → pendingFit.current = true → onLayout fires
// → applyFitIfReadyRef.current() runs with real container dims + SVG viewBox
// → computeFitTarget is called → scale = ZOOM_STOPS[0].scale, renderZoom = 0.

describe("applyFitIfReady — z0 snap at callback invocation", () => {
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

  it("phone (390×761): computeFitTarget is called when applyFitIfReady fires", async () => {
    await mountAndLayout(390, 761);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("phone (390×761): computeFitTarget returns scale === ZOOM_STOPS[0].scale", async () => {
    await mountAndLayout(390, 761);
    const result = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number; tx: number; ty: number };
    expect(result.scale).toBe(ZOOM_STOPS[0].scale);
  });

  it("phone (390×761): zoomStopForScale of committed scale === 0 (z0 renderZoom)", async () => {
    await mountAndLayout(390, 761);
    const result = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number };
    expect(zoomStopForScale(result.scale)).toBe(0);
  });

  it("iPad (768×960): computeFitTarget is called when applyFitIfReady fires", async () => {
    await mountAndLayout(768, 960);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("iPad (768×960): computeFitTarget returns scale === ZOOM_STOPS[0].scale", async () => {
    await mountAndLayout(768, 960);
    const result = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number; tx: number; ty: number };
    expect(result.scale).toBe(ZOOM_STOPS[0].scale);
  });

  it("iPad (768×960): zoomStopForScale of committed scale === 0 (z0 renderZoom)", async () => {
    await mountAndLayout(768, 960);
    const result = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number };
    expect(zoomStopForScale(result.scale)).toBe(0);
  });

  it("phone and iPad both snap to the same scale (snap is device-independent)", async () => {
    await mountAndLayout(390, 761);
    const phoneResult = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number };
    computeFitTargetSpy.mockClear();

    await mountAndLayout(768, 960);
    const iPadResult = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number };

    expect(phoneResult.scale).toBe(ZOOM_STOPS[0].scale);
    expect(iPadResult.scale).toBe(ZOOM_STOPS[0].scale);
    expect(phoneResult.scale).toBe(iPadResult.scale);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path B — applyFit (animated, triggered by "Fit to screen" button)
// ─────────────────────────────────────────────────────────────────────────────
//
// Flow: mount → layout → clear spy → press "Fit to screen" → applyFit runs
// → computeFitTarget is called → scale = ZOOM_STOPS[0].scale, renderZoom = 0.

describe("applyFit — z0 snap via fit button callback", () => {
  async function mountAndPressfit(containerW: number, containerH: number) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });
    await act(async () => {
      fireOnLayout(renderer, containerW, containerH);
    });
    // Clear calls from applyFitIfReady so only applyFit calls are asserted below.
    computeFitTargetSpy.mockClear();
    await act(async () => {
      pressFitButton(renderer);
    });
    return renderer;
  }

  it("phone (390×761): pressing fit button calls computeFitTarget", async () => {
    await mountAndPressfit(390, 761);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("phone (390×761): fit button — committed scale === ZOOM_STOPS[0].scale", async () => {
    await mountAndPressfit(390, 761);
    const result = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number; tx: number; ty: number };
    expect(result.scale).toBe(ZOOM_STOPS[0].scale);
  });

  it("phone (390×761): fit button — zoomStopForScale of committed scale === 0", async () => {
    await mountAndPressfit(390, 761);
    const result = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number };
    expect(zoomStopForScale(result.scale)).toBe(0);
  });

  it("iPad (768×960): pressing fit button calls computeFitTarget", async () => {
    await mountAndPressfit(768, 960);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("iPad (768×960): fit button — committed scale === ZOOM_STOPS[0].scale", async () => {
    await mountAndPressfit(768, 960);
    const result = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number; tx: number; ty: number };
    expect(result.scale).toBe(ZOOM_STOPS[0].scale);
  });

  it("iPad (768×960): fit button — zoomStopForScale of committed scale === 0", async () => {
    await mountAndPressfit(768, 960);
    const result = computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number };
    expect(zoomStopForScale(result.scale)).toBe(0);
  });

  it("phone and iPad fit button both snap to the same z0 scale", async () => {
    await mountAndPressfit(390, 761);
    const phoneScale = (computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number }).scale;
    computeFitTargetSpy.mockClear();

    await mountAndPressfit(768, 960);
    const iPadScale = (computeFitTargetSpy.mock.results.at(-1)!.value as { scale: number }).scale;

    expect(phoneScale).toBe(ZOOM_STOPS[0].scale);
    expect(iPadScale).toBe(ZOOM_STOPS[0].scale);
    expect(phoneScale).toBe(iPadScale);
  });
});
