/**
 * Regression smoke-test: TDZ-style forward-reference crash in WarehouseMapView
 *
 * Background
 * ──────────
 * The Map tab crashed on web because `pinchGesture` captured `_cancelPrefetch`
 * and `snapToNearestZoomStop` via `runOnJS()` before those `const` bindings
 * were initialised (Temporal Dead Zone).  TypeScript and ESLint are both blind
 * to declaration-order TDZ bugs; only a render attempt surfaces them.
 *
 * What this test does
 * ───────────────────
 * Mounts WarehouseMapView with Platform.OS = "web" and minimal props, then
 * asserts the component tree was created without throwing a ReferenceError (or
 * any other Error).  If the declaration order regresses, the `Gesture.Pinch()`
 * builder call that references the still-uninitialised consts will throw during
 * the first render and the test will fail.
 *
 * Mock strategy
 * ─────────────
 * Identical to warehouseMapCacheCleanup.test.tsx: all heavy native modules are
 * stubbed inline so react-test-renderer can import and render the component.
 * No `onLayout` is fired so `containerW` stays 0 and the component hits its
 * early-return guard — only the gesture-setup and hook-initialisation code runs,
 * which is exactly the code path where TDZ violations occur.
 */

// React 19 requires IS_REACT_ACT_ENVIRONMENT = true for act() to flush
// synchronous state updates and suppress spurious act() warnings.
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
    cancelAnimation: () => {},
    withSpring: passThrough,
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

// ─── @/utils/apiBase ─────────────────────────────────────────────────────────
// Return an empty API_BASE so the server-hash polling setInterval in
// WarehouseMapView (guarded by `if (!API_BASE) return`) is never registered.
// Without this mock the guard throws in Jest (__DEV__=false, no env var set)
// before any test can run.
jest.mock("@/utils/apiBase", () => ({ API_BASE: "" }));

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

// ─── @expo/vector-icons ───────────────────────────────────────────────────────
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));

// ─── @react-native-async-storage/async-storage ───────────────────────────────
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    multiGet: jest.fn(() => Promise.resolve([])),
  },
}));

// ─── @/utils/floorPlan ────────────────────────────────────────────────────────
jest.mock("@/utils/floorPlan", () => ({
  warmupTiles: jest.fn(() => Promise.resolve()),
  tileApiUrl: jest.fn((z: number, x: number, y: number) =>
    `/floor-plan/tiles/${z}/${x}/${y}.png`),
}));

// ─── @/utils/tilePyramidCache ─────────────────────────────────────────────────
jest.mock("@/utils/tilePyramidCache", () => ({
  cleanStaleCacheDirs: jest.fn(() => Promise.resolve()),
  fetchTile: jest.fn(() => Promise.resolve("")),
  prefetchZoomLevel: jest.fn(() => Promise.resolve()),
}));

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────
jest.mock("@/utils/floorPlanCache", () => ({
  getCachedHash: jest.fn(() => null),
  getCachedData: jest.fn(() => null),
  hasCachedData: jest.fn(() => false),
  getIfValid: jest.fn(() => null),
  initPersistRead: jest.fn(() => Promise.resolve()),
  resetForServerUpdate: jest.fn(),
  setCached: jest.fn(),
  setFallbackEmpty: jest.fn(),
}));

// ─── import component under test (after all mocks) ───────────────────────────
import { WarehouseMapView } from "@/components/WarehouseMapView";

// ─── Minimal valid props ──────────────────────────────────────────────────────
const NOOP = jest.fn();
const BASE_PROPS = {
  zones: [],
  zonesLoading: false,
  zonesError: false,
  onZonesRetry: NOOP,
  onZoneTap: NOOP,
};

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Fake timers prevent the 3 s setEmptyDismissed setTimeout from firing as a
  // real macrotask after each test ends.  nextTick/setImmediate are kept real so
  // act(async) and Promise chains resolve normally.
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });

  jest.clearAllMocks();
  // Force web mode — this is the platform where the TDZ crash occurred.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require("react-native").Platform as { OS: string }).OS = "web";
});

afterEach(() => {
  // Restore real timers and native platform so other test files are not affected.
  jest.useRealTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require("react-native").Platform as { OS: string }).OS = "ios";
});

// ─────────────────────────────────────────────────────────────────────────────
// TDZ smoke-test: render on web must not throw a ReferenceError
// ─────────────────────────────────────────────────────────────────────────────
//
// The regression: pinchGesture captured _cancelPrefetch and snapToNearestZoomStop
// via runOnJS() before those consts were declared. The React Compiler reads
// callback bindings during render to build memoisation, so a declaration that
// appears after its consumer in the function body throws ReferenceError on the
// very first render — silently on native (where the worklet plugin hoists the
// values into a separate closure), but fatally on web.

describe("WarehouseMapView — web render smoke-test (TDZ regression guard)", () => {
  it("renders on web without throwing a ReferenceError", async () => {
    await expect(
      act(async () => {
        TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
      })
    ).resolves.not.toThrow();
  });

  it("produces a non-null renderer instance on web", async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    expect(renderer).not.toBeNull();
    // The component renders at least one element — confirms the tree was
    // actually created rather than short-circuiting to null via an error boundary.
    expect((renderer as unknown as TestRenderer.ReactTestRenderer).toJSON()).not.toBeNull();
  });

  it("renders consistently across two successive mounts on web", async () => {
    // A TDZ crash would throw on both mounts — two independent mount attempts
    // confirm the failure is not a one-off initialisation artifact.
    await act(async () => {
      TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    await act(async () => {
      TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    // If we reach here, neither mount threw — the test passes.
    expect(true).toBe(true);
  });
});
