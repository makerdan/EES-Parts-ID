/**
 * Regression tests: WarehouseMapView viewport behaviour.
 *
 * Four runtime paths are covered across five suites:
 *
 *   1. Fresh app open (warm cache) → fit-to-screen always runs, regardless of
 *      any previously saved viewport.  The viewport key is NOT read on mount —
 *      the restore path has been intentionally removed so the map is always
 *      centred when the user opens it.  Other startup preferences may still
 *      use AsyncStorage.
 *
 *   2. No saved viewport (null) → same as above; pendingFit is set and
 *      applyFitIfReady fires once both contentVBRef and containerW are ready.
 *
 *   3. Startup fit — no AsyncStorage.getItem call during mount (three
 *      targeted assertions confirming the read path is gone).
 *
 *   4. App backgrounded → the AppState "background" handler immediately calls
 *      AsyncStorage.setItem to flush any pending debounced viewport write so
 *      the OS does not suspend the process before the data is persisted.
 *
 *   5. Cold cache (getCachedData returns null) → after the SVG XML loads from
 *      the bundle fallback, computeFitTarget is called and scale/tx/ty shared
 *      values are applied via applyFitIfReady.
 *
 * Mock strategy
 * ─────────────
 * • useSharedValue returns a tracked plain object; every instance is pushed to
 *   `trackedValues` so tests can inspect post-mount / post-layout .value
 *   mutations without knowing which slot in the component each value occupies.
 * • AsyncStorage.getItem is a jest.fn() — tests assert the viewport key is NOT
 *   read on mount (new semantics).  setItem is tracked to verify background-
 *   flush calls in suite 4.
 * • panBounds is spied upon and mocked to return {maxX:10000, maxY:10000} so
 *   the small test tx/ty values pass through clamping unchanged.
 * • AppState.addEventListener in the react-native mock is re-implemented
 *   per-test to capture the registered handler so suite 4 can fire synthetic
 *   background events.
 * • Suites 1, 2, and 4 use real timers.  Suite 3 (background-flush) switches
 *   to jest.useFakeTimers() so that persistViewport's 300 ms setTimeout is a
 *   fake handle that never touches the real event loop; jest.runAllTimers() in
 *   its afterEach drains any remaining fake timers before real timers are
 *   restored, preventing dangling handles between test runs.
 */

// React 19 requires IS_REACT_ACT_ENVIRONMENT = true for act() to flush
// synchronous state updates triggered by onLayout.
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";

// ─── react-native-reanimated ──────────────────────────────────────────────────
// Shared values are tracked plain objects.  Every useSharedValue call pushes
// its returned { value } object into `trackedValues` so tests can verify that
// the fit path mutated the scale/translateX/translateY slots.

const trackedValues: Array<{ value: unknown }> = [];

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
    useSharedValue: (initial: unknown) => {
      const sv = { value: initial };
      trackedValues.push(sv);
      return sv;
    },
    useAnimatedProps: (_fn: () => unknown) => ({}),
    useAnimatedStyle: (_fn: () => unknown) => ({}),
    useAnimatedReaction: () => {},
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    cancelAnimation: () => {},
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
    // Use "Text" (not "svg-text") so the new test-renderer's strict text host
    // check (textComponentTypes: ['Text','RCTText']) doesn't throw when SVG
    // Text elements render string children.
    Text: make("Text"),
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

// ─── react-native ────────────────────────────────────────────────────────────
// RTLRN v14 uses test-renderer@1.x which enforces that text strings may only
// appear inside host elements whose type is in ['Text', 'RCTText'].  The global
// react-native mock maps Text → "rn-text" (used by 100+ other test files), so
// we provide a local override that re-exports the global mock but remaps Text
// to the "Text" host element name that test-renderer accepts.
jest.mock("react-native", () => {
  const React = require("react");
  // jest.requireActual applies moduleNameMapper (→ global __mocks__/react-native.js)
  // but skips jest.mock() factories, avoiding circular stack overflow.
  const rnMock = jest.requireActual("react-native") as Record<string, unknown>;
  return {
    ...rnMock,
    Text: ({ children, ...props }: Record<string, unknown>) =>
      React.createElement("Text", props, children),
  };
});

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));

// ─── @react-native-async-storage/async-storage ───────────────────────────────
// getItem is a jest.fn() — tests assert it is NOT called on mount.
// setItem is tracked to verify background-flush calls in suite 4.

const mockAsyncStorageGetItem = jest.fn<Promise<string | null>, [string]>(
  () => Promise.resolve(null),
);
const mockAsyncStorageSetItem = jest.fn<Promise<void>, [string, string]>(
  () => Promise.resolve(),
);

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:    mockAsyncStorageGetItem,
    setItem:    mockAsyncStorageSetItem,
    removeItem: jest.fn(() => Promise.resolve()),
    multiGet:   jest.fn(() => Promise.resolve([])),
  },
}));

// ─── @/utils/appAuth ─────────────────────────────────────────────────────────
// Default: returns a non-ok response so _loadFloorPlanFromServer always fails
// and falls back to the bundled asset.  Cold-cache tests rely on this.
// Warm-cache tests never reach fetchWithAuth (hasCachedData() returns true).

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth:       jest.fn(() => Promise.resolve({ ok: false })),
  setAuthTokenGetter:  jest.fn(),
  onUnauthorized:      jest.fn(),
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
// Returns a pre-parsed contentViewBox so contentVBRef is populated on mount
// and applyFitIfReady can run.  xml/uri are empty so the tile-render path is
// never entered, avoiding undefined-component errors from SVG mocks.

const MOCK_CONTENT_VB = { x: 60, y: 80, w: 7200, h: 4820 };
const MOCK_CACHED_DATA = {
  uri:            "",
  innerXml:       "",
  xml:            "",
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

// ─── Component and utilities ──────────────────────────────────────────────────

import { WarehouseMapView } from "@/components/WarehouseMapView";
import { ZOOM_STOPS } from "@/utils/mapViewport";

// ─── Constants ────────────────────────────────────────────────────────────────
// Must match the constant in WarehouseMapView.tsx so setItem assertions can
// verify the correct key is used.
const VIEWPORT_KEY = "@rdc34/warehouse_map_viewport_v2";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOOP = jest.fn();
const BASE_PROPS = {
  zones:        [],
  zonesLoading: false,
  zonesError:   false,
  onZonesRetry: NOOP,
  onZoneTap:    NOOP,
};

// ─── Tree traversal helpers ───────────────────────────────────────────────────
// RTLRN v14 uses the new `test-renderer` package whose TestInstance exposes
// queryAll(predicate) instead of the old findAll(predicate, { deep: true }).

function fireOnLayout(
  renderer: RenderResult,
  width: number,
  height: number,
) {
  // { includeSelf: true } is required: the new test-renderer's queryAll
  // defaults to includeSelf:false which skips the root node itself — the
  // outermost View with onLayout may be the root element.
  const nodes = renderer.root!.queryAll(
    (n) => typeof n.props.onLayout === "function",
    { includeSelf: true },
  );
  if (nodes.length === 0) throw new Error("No onLayout node found");
  nodes[0]!.props.onLayout({
    nativeEvent: { layout: { width, height, x: 0, y: 0 } },
  });
}

function pressFitButton(renderer: RenderResult) {
  const btn = renderer.root!.queryAll(
    (n) => n.props.accessibilityLabel === "Fit to screen",
    { includeSelf: true },
  )[0];
  btn!.props.onPress();
}

/** Flush microtask queues (enough to resolve Promise chains). */
const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

// ─── Per-test setup / teardown ───────────────────────────────────────────────

let computeFitTargetSpy: jest.SpyInstance;
let panBoundsSpy: jest.SpyInstance;

beforeEach(() => {
  // Fake timers prevent the 3 s setEmptyDismissed setTimeout (WarehouseMapView
  // line ~846) from firing as a real macrotask after the test ends.  Promises
  // and microtasks (nextTick / setImmediate) are kept real so flushPromises()
  // and act(async) continue to work correctly.  Suite 4 overrides this with its
  // own jest.useFakeTimers() call and restores real timers in its own afterEach,
  // which is safe because jest.useRealTimers() is idempotent.
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });

  jest.clearAllMocks();
  trackedValues.length = 0;

  const fpc = require("@/utils/floorPlanCache");
  fpc.getCachedData.mockReturnValue(MOCK_CACHED_DATA);
  fpc.hasCachedData.mockReturnValue(true);
  fpc.getCachedHash.mockReturnValue("abc123");

  const mapViewport = require("@/utils/mapViewport");
  computeFitTargetSpy = jest.spyOn(mapViewport, "computeFitTarget");
  // Mock panBounds to return very large bounds so test tx/ty values (30, 20)
  // pass through clamping unchanged.  This makes the expected restore values
  // deterministic regardless of the real SVG_ASPECT geometry.
  panBoundsSpy = jest
    .spyOn(mapViewport, "panBounds")
    .mockReturnValue({ maxX: 10_000, maxY: 10_000 });

  mockAsyncStorageGetItem.mockReset();
  mockAsyncStorageGetItem.mockResolvedValue(null);
  mockAsyncStorageSetItem.mockReset();
  mockAsyncStorageSetItem.mockResolvedValue(undefined);

  (require("react-native").Platform as { OS: string }).OS = "ios";
});

afterEach(() => {
  computeFitTargetSpy.mockRestore();
  panBoundsSpy.mockRestore();
  // Restore real timers so subsequent suites that manage their own fake-timer
  // lifecycle (Suite 4) start from a known real-timer state.  Calling this when
  // timers are already real (Suite 4 restores them in its own afterEach) is safe.
  jest.useRealTimers();
});

// =============================================================================
// Suite 1 — Startup always fits: fresh app open always centres the floor plan
//
// The viewport restore path has been removed — AsyncStorage.getItem is never
// called on mount.  pendingFit stays true so applyFitIfReady fires once both
// contentVBRef and containerW are available, regardless of any stored viewport.
// =============================================================================

describe("startup always fits — no viewport restore on mount", () => {
  async function mountAndLayout(containerW: number, containerH: number) {
    // render() in RTLRN v14 is async and already wraps in act() internally.
    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await flushPromises();
    await act(async () => {
      fireOnLayout(renderer, containerW, containerH);
    });
    return renderer;
  }

  it("phone (390×761): computeFitTarget is called on mount (fit always runs)", async () => {
    await mountAndLayout(390, 761);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("phone (390×761): computeFitTarget is called with the cached contentViewBox", async () => {
    await mountAndLayout(390, 761);
    const call = computeFitTargetSpy.mock.calls[0] as [unknown, number, number];
    expect(call[0]).toEqual(MOCK_CONTENT_VB);
  });

  it("phone (390×761): at least two shared values hold the natural fit scale (scale + savedScale)", async () => {
    await mountAndLayout(390, 761);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    const matches = trackedValues.filter((sv) => sv.value === result.scale);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("phone (390×761): the viewport key is NOT read on mount (no restore path)", async () => {
    await mountAndLayout(390, 761);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalledWith(VIEWPORT_KEY);
  });

  it("phone (390×761): computeFitTarget returns the natural fit scale (not snapped to z0 overview)", async () => {
    await mountAndLayout(390, 761);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    // With snapToOverview:false the initial fit returns the raw fitContentViewport
    // scale (≤ MIN_SCALE for this large MOCK_CONTENT_VB), not ZOOM_STOPS[0].scale.
    expect(result.scale).not.toBe(ZOOM_STOPS[0]!.scale);
    expect(result.scale).toBeGreaterThan(0);
  });

  it("iPad (768×960): computeFitTarget is called on mount", async () => {
    await mountAndLayout(768, 960);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("iPad (768×960): at least two shared values hold the natural fit scale", async () => {
    await mountAndLayout(768, 960);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    const matches = trackedValues.filter((sv) => sv.value === result.scale);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("iPad (768×960): the viewport key is NOT read on mount", async () => {
    await mountAndLayout(768, 960);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalledWith(VIEWPORT_KEY);
  });
});

// =============================================================================
// Suite 2 — No saved viewport: pendingFit set, applyFitIfReady called
//
// AsyncStorage.getItem returns null (not called at all in new semantics).
// Expected: computeFitTarget is called and shared values are set to
// ZOOM_STOPS[0].scale / fit tx / fit ty.
// =============================================================================

describe("no saved viewport — pendingFit set and applyFitIfReady fires", () => {
  async function mountFitLayout(containerW: number, containerH: number) {
    mockAsyncStorageGetItem.mockResolvedValue(null);

    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await flushPromises();
    await act(async () => {
      fireOnLayout(renderer, containerW, containerH);
    });
    return renderer;
  }

  it("phone (390×761): computeFitTarget is called when no stored viewport exists", async () => {
    await mountFitLayout(390, 761);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("phone (390×761): computeFitTarget is called with the cached contentViewBox", async () => {
    await mountFitLayout(390, 761);
    const call = computeFitTargetSpy.mock.calls[0] as [unknown, number, number];
    expect(call[0]).toEqual(MOCK_CONTENT_VB);
  });

  it("phone (390×761): computeFitTarget returns the natural fit scale (not snapped to z0 overview)", async () => {
    await mountFitLayout(390, 761);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    // With snapToOverview:false the initial fit returns the raw fitContentViewport
    // scale (≤ MIN_SCALE for this large MOCK_CONTENT_VB), not ZOOM_STOPS[0].scale.
    expect(result.scale).not.toBe(ZOOM_STOPS[0]!.scale);
    expect(result.scale).toBeGreaterThan(0);
  });

  it("phone (390×761): at least two shared values hold the natural fit scale after fit", async () => {
    await mountFitLayout(390, 761);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    const matches = trackedValues.filter((sv) => sv.value === result.scale);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("phone (390×761): the viewport key is NOT read on mount (no restore path)", async () => {
    await mountFitLayout(390, 761);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalledWith(VIEWPORT_KEY);
  });

  it("iPad (768×960): computeFitTarget is called when no stored viewport exists", async () => {
    await mountFitLayout(768, 960);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("iPad (768×960): computeFitTarget returns the natural fit scale (not snapped to z0 overview)", async () => {
    await mountFitLayout(768, 960);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    // With snapToOverview:false the initial fit returns the raw fitContentViewport
    // scale (≤ MIN_SCALE for this large MOCK_CONTENT_VB), not ZOOM_STOPS[0].scale.
    expect(result.scale).not.toBe(ZOOM_STOPS[0]!.scale);
    expect(result.scale).toBeGreaterThan(0);
  });
});

// =============================================================================
// Suite 3 — Startup fit: no AsyncStorage.getItem call during mount
//
// Three targeted assertions confirming the viewport-restore read path is gone.
// These tests mount the component with a stored viewport JSON available in the
// mock but verify that getItem is never called — the map always fits to screen
// on a fresh open regardless of what is in storage.
// =============================================================================

describe("startup fit — no viewport-key AsyncStorage read during mount", () => {
  // Use a scale value clearly different from ZOOM_STOPS[0].scale (1.5) so we
  // can verify the stored scale is ignored and the fit scale is applied instead.
  const STORED_VIEWPORT = JSON.stringify({ s: 4.0, tx: 30, ty: 20 });

  async function mountAndLayout(containerW: number, containerH: number) {
    // Make a stored viewport available — the component must NOT read it.
    mockAsyncStorageGetItem.mockResolvedValue(STORED_VIEWPORT);
    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await flushPromises();
    await act(async () => {
      fireOnLayout(renderer, containerW, containerH);
    });
    return renderer;
  }

  it("phone (390×761): the viewport key is not read even when stored data exists", async () => {
    await mountAndLayout(390, 761);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalledWith(VIEWPORT_KEY);
  });

  it("iPad (768×960): the viewport key is not read even when stored data exists", async () => {
    await mountAndLayout(768, 960);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalledWith(VIEWPORT_KEY);
  });

  it("phone (390×761): fit-to-screen scale is applied (stored s=4.0 is ignored; natural fit scale is used)", async () => {
    await mountAndLayout(390, 761);
    // Stored scale (4.0) must NOT appear in tracked shared values.
    const storedScaleMatches = trackedValues.filter((sv) => sv.value === 4.0);
    expect(storedScaleMatches.length).toBe(0);
    // The natural fit scale (snapToOverview:false) must appear (scale + savedScale).
    const fitResult = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    const fitScaleMatches = trackedValues.filter((sv) => sv.value === fitResult.scale);
    expect(fitScaleMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Suite 4 — AppState "background": pending _persistTimer is flushed immediately
//
// Flow:
//   1. Mount with null → pendingFit → applyFitIfReady (no debounced write).
//   2. Press "Fit to screen" → applyFit → persistViewport → setTimeout(300).
//   3. The 300 ms has not elapsed, so _persistTimer.current is non-null.
//   4. Synthetic "background" AppState event fires → handler calls
//      clearTimeout + AsyncStorage.setItem immediately.
//   5. Assert setItem was called with VIEWPORT_KEY.
// =============================================================================

describe("AppState background handler — flushes pending _persistTimer write", () => {
  let capturedAppStateHandler: ((state: string) => void) | null = null;

  beforeEach(() => {
    // Switch to fake timers so persistViewport's 300 ms setTimeout is a fake
    // handle that never touches the real event loop.  This prevents Jest from
    // reporting "Have you considered using --detectOpenHandles" after the suite.
    jest.useFakeTimers();

    // Override the already-jest.fn() addEventListener in the RN mock to
    // capture the registered handler so tests can fire synthetic events.
    const rn = require("react-native");
    rn.AppState.addEventListener.mockImplementation(
      (_evt: string, handler: (s: string) => void) => {
        capturedAppStateHandler = handler;
        return { remove: jest.fn() };
      },
    );
  });

  afterEach(() => {
    // Drain any remaining fake timers, then restore real timers so subsequent
    // suites (and the outer afterEach) are unaffected.
    jest.runAllTimers();
    jest.useRealTimers();
    capturedAppStateHandler = null;
  });

  it("fires AsyncStorage.setItem immediately when backgrounded with a pending write", async () => {
    mockAsyncStorageGetItem.mockResolvedValue(null);

    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await flushPromises();
    await act(async () => {
      fireOnLayout(renderer, 390, 761);
    });

    // Press "Fit to screen" → applyFit → persistViewport → setTimeout(300 ms).
    // Real timers are in use; 300 ms will NOT have elapsed before the assertion.
    await act(async () => {
      pressFitButton(renderer);
    });

    // Clear any setItem calls that may have occurred before the fit press
    // (there should be none since persistViewport was not called yet, but
    // clearing makes the assertion below unambiguous).
    mockAsyncStorageSetItem.mockClear();

    // AppState handler must have been captured by the useEffect.
    expect(capturedAppStateHandler).not.toBeNull();

    // Simulate the OS moving the app to background.
    capturedAppStateHandler!("background");

    // The handler must have called setItem synchronously.
    expect(mockAsyncStorageSetItem).toHaveBeenCalledTimes(1);
    expect(mockAsyncStorageSetItem).toHaveBeenCalledWith(
      VIEWPORT_KEY,
      expect.any(String),
    );

    // Verify the stored JSON is parseable and contains the expected fields.
    const storedRaw = mockAsyncStorageSetItem.mock.calls[0]![1] as string;
    const stored = JSON.parse(storedRaw) as { s: number; tx: number; ty: number };
    expect(typeof stored.s).toBe("number");
    expect(typeof stored.tx).toBe("number");
    expect(typeof stored.ty).toBe("number");

    // Unmount so the cleanup effect cancels the timer (avoids test pollution).
    // In RTLRN v14, unmount() is async and wraps in act() internally.
    await renderer.unmount();
  });

  it("does NOT call AsyncStorage.setItem when backgrounded with no pending write", async () => {
    mockAsyncStorageGetItem.mockResolvedValue(null);

    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await flushPromises();
    await act(async () => {
      fireOnLayout(renderer, 390, 761);
    });

    // Do NOT press fit — no persistViewport call, so _persistTimer is null.
    mockAsyncStorageSetItem.mockClear();

    expect(capturedAppStateHandler).not.toBeNull();
    capturedAppStateHandler!("background");

    // No pending timer → handler must not call setItem.
    expect(mockAsyncStorageSetItem).not.toHaveBeenCalled();

    await renderer.unmount();
  });
});

// =============================================================================
// Suite 5 — cold-cache startup fit (getCachedData returns null on first install)
// =============================================================================
//
// Covers the code path where the in-memory SVG cache is empty (first install or
// after a cache clear).  In this path:
//   1. getCachedData() returns null → svgXml state starts as "", contentVBRef = null.
//   2. hasCachedData() returns false → the SVG load effect runs instead of returning early.
//   3. _loadFloorPlanFromServer fails (fetchWithAuth returns { ok: false }).
//   4. Falls back to _loadFloorPlanFromBundle → Asset.loadAsync → fetch(localUri) →
//      parseContentViewBox → setCached updates the mock cache.
//   5. getSvgXml state is set → the svgXml parse effect fires → contentVBRef populated.
//   6. applyFitIfReady() succeeds (pendingFit = true because no restore runs on mount,
//      containerW already known from the onLayout that fired before the SVG arrived).
//   7. computeFitTarget is called and shared values are updated.
//
// The suite uses a single comprehensive test for the full async chain, avoiding the
// module-level _svgLoadPromise singleton from affecting independent assertions.

describe("startup fit — cold cache (getCachedData returns null on first install)", () => {
  // An SVG string whose viewBox matches MOCK_CONTENT_VB so parseContentViewBox
  // returns the same rect the warm-cache tests use, keeping assertions consistent.
  const COLD_SVG_XML = `<svg viewBox="${MOCK_CONTENT_VB.x} ${MOCK_CONTENT_VB.y} ${MOCK_CONTENT_VB.w} ${MOCK_CONTENT_VB.h}"><g/></svg>`;

  // Tracks in-memory cache state for cold-cache tests.  Starts null (cold) and
  // is populated when the mocked setCached fires during _loadFloorPlanFromBundle.
  let coldData: typeof MOCK_CACHED_DATA | null = null;

  beforeEach(() => {
    coldData = null;

    const fpc = require("@/utils/floorPlanCache");

    // Override the warm-cache defaults set by the outer beforeEach.
    fpc.getCachedData.mockImplementation(() => coldData);
    fpc.hasCachedData.mockReturnValue(false);
    fpc.getCachedHash.mockReturnValue(null);
    // getIfValid must return null (cache miss) so _loadFloorPlanFromBundle
    // does not short-circuit before calling setCached.  jest.clearAllMocks()
    // would have left it returning undefined, which !== null passes the guard
    // and causes the function to return before setCached is ever called.
    fpc.getIfValid.mockReturnValue(null);

    // setCached populates coldData so subsequent getCachedData() calls return
    // the freshly loaded SVG (matching what the real cache module does).
    fpc.setCached.mockImplementation(
      (
        _hash: string,
        data: {
          uri: string;
          innerXml: string;
          xml: string;
          contentViewBox?: { x: number; y: number; w: number; h: number };
        },
      ) => {
        coldData = {
          uri:          data.uri,
          innerXml:     data.innerXml,
          xml:          data.xml,
          contentViewBox: data.contentViewBox ?? MOCK_CONTENT_VB,
        };
      },
    );

    // fetchWithAuth returns a non-ok response so _loadFloorPlanFromServer throws
    // and the load falls through to _loadFloorPlanFromBundle.
    const appAuth = require("@/utils/appAuth");
    appAuth.fetchWithAuth.mockResolvedValue({ ok: false });

    // The outer beforeEach calls jest.clearAllMocks() which clears the
    // expo-asset mock implementation.  Restore it so Asset.loadAsync() returns
    // the expected bundle asset during _loadFloorPlanFromBundle.
    const expoAsset = require("expo-asset");
    expoAsset.Asset.loadAsync.mockResolvedValue([{
      uri:        "file:///mock/floor-plan.svg",
      localUri:   "file:///mock/floor-plan.svg",
      downloaded: true,
      hash:       "bundle-hash",
    }]);

    // global.fetch serves the SVG bytes for the bundle-fallback local-file read.
    global.fetch = jest.fn().mockResolvedValue({
      ok:   true,
      text: () => Promise.resolve(COLD_SVG_XML),
    } as unknown as Response);
  });

  afterEach(() => {
    // Remove the global.fetch override so it doesn't leak into other suites.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
  });

  // Helper: mount the component and fire onLayout with the given dimensions.
  async function mountAndLayout(containerW: number, containerH: number) {
    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await act(async () => {
      fireOnLayout(renderer, containerW, containerH);
    });
    return renderer;
  }

  // Helper: mount + layout + drain all async SVG-load work.
  //
  // The cold-cache load chain is a Promise waterfall:
  //   _persistReadPromise (1 tick) →
  //   fetchWithAuth (1 tick) → throws → .catch →
  //   Asset.loadAsync (1 tick) →
  //   fetch(localUri) (1 tick) →
  //   res.text() (1 tick) →
  //   setCached / getSvgXml / setSvgXml (sync + React batch) →
  //   svgXml parse effect → applyFitIfReady → computeFitTarget
  //
  // Each `await act(async () => { await Promise.resolve(); })` advances
  // exactly one microtask tick AND flushes any React state updates +
  // effects triggered by that tick.  12 rounds is enough headroom for
  // the full chain (the real depth is ~6 ticks).
  async function mountLayoutAndDrain(containerW: number, containerH: number) {
    const renderer = await mountAndLayout(containerW, containerH);
    for (let i = 0; i < 12; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    return renderer;
  }

  it(
    "phone (390×761): computeFitTarget is called and scale/tx/ty are applied " +
    "after SVG XML arrives from cold cache",
    async () => {
      await mountLayoutAndDrain(390, 761);

      // computeFitTarget must have been called by applyFitIfReady once both
      // contentVBRef (populated by the svgXml parse effect) and containerW
      // (populated by onLayout) are available.
      expect(computeFitTargetSpy).toHaveBeenCalled();

      // The first call must receive the parsed contentViewBox, not a stale default.
      const call = computeFitTargetSpy.mock.calls[0] as [unknown, number, number];
      expect(call[0]).toEqual(MOCK_CONTENT_VB);
      expect(call[1]).toBe(390);
      expect(call[2]).toBe(761);

      // applyFitIfReady writes the fit result to six shared values:
      // scale, savedScale, translateX, translateY, savedTX, savedTY.
      // At least one tracked shared value must hold each of scale, tx, ty.
      const { scale: fitScale, tx: fitTx, ty: fitTy } =
        computeFitTargetSpy.mock.results[0]!.value as {
          scale: number; tx: number; ty: number;
        };
      expect(trackedValues.some((sv) => sv.value === fitScale)).toBe(true);
      expect(trackedValues.some((sv) => sv.value === fitTx)).toBe(true);
      expect(trackedValues.some((sv) => sv.value === fitTy)).toBe(true);

      // The startup-fit useEffect does NOT read the viewport key on mount.
      expect(mockAsyncStorageGetItem).not.toHaveBeenCalledWith(VIEWPORT_KEY);
    },
  );

});

// =============================================================================
// Suite 6 — Device rotation: translate values scale by newW/oldW ratio
// =============================================================================

describe("device rotation — translate values scale by newW/oldW ratio", () => {
  const PORTRAIT_W  = 390;
  const PORTRAIT_H  = 761;
  const LANDSCAPE_W = 844;
  const LANDSCAPE_H = 390;
  const FIT_TX = 30;
  const FIT_TY = 20;

  beforeEach(() => {
    computeFitTargetSpy.mockReturnValue({
      scale: ZOOM_STOPS[0]!.scale,
      tx:    FIT_TX,
      ty:    FIT_TY,
    });
  });

  it("portrait→landscape: scales translateX and translateY by newW/oldW", async () => {
    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await flushPromises();

    await act(async () => {
      fireOnLayout(renderer, PORTRAIT_W, PORTRAIT_H);
    });

    await act(async () => {
      fireOnLayout(renderer, LANDSCAPE_W, LANDSCAPE_H);
    });

    const sizeRatio  = LANDSCAPE_W / PORTRAIT_W;
    const expectedTX = FIT_TX * sizeRatio;
    const expectedTY = FIT_TY * sizeRatio;

    expect(trackedValues.some((sv) => sv.value === expectedTX)).toBe(true);
    expect(trackedValues.some((sv) => sv.value === expectedTY)).toBe(true);
  });

  it("landscape→portrait: scales translateX and translateY by newW/oldW", async () => {
    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await flushPromises();

    await act(async () => {
      fireOnLayout(renderer, LANDSCAPE_W, LANDSCAPE_H);
    });

    await act(async () => {
      fireOnLayout(renderer, PORTRAIT_W, PORTRAIT_H);
    });

    const sizeRatio  = PORTRAIT_W / LANDSCAPE_W;
    const expectedTX = FIT_TX * sizeRatio;
    const expectedTY = FIT_TY * sizeRatio;

    expect(trackedValues.some((sv) => sv.value === expectedTX)).toBe(true);
    expect(trackedValues.some((sv) => sv.value === expectedTY)).toBe(true);
  });
});

// =============================================================================
// Suite 7 — _applyFocus: zone found, zone not found, section disambiguation
// =============================================================================

describe("_applyFocus — zone found / not found / section disambiguation", () => {
  const FOCUS_ZONE: import("@/hooks/useWarehouseZones").ApiWarehouseZone = {
    id:          1,
    aisleId:     "5",
    sectionNum:  1,
    isInventory: true,
    svgX:        1000,
    svgY:        2000,
    svgWidth:    500,
    svgHeight:   300,
    sortOrder:   0,
    createdAt:   "",
    updatedAt:   "",
  };
  const EXPECTED_CX = FOCUS_ZONE.svgX + FOCUS_ZONE.svgWidth  / 2;
  const EXPECTED_CY = FOCUS_ZONE.svgY + FOCUS_ZONE.svgHeight / 2;

  // Helper: mount WITHOUT focusAisleNum, lay out, clear spy, then rerender
  // with the supplied extra props.
  // In RTLRN v14, rerender() is async and already wraps in act() internally.
  async function mountThenFocus(
    extraProps: Partial<Parameters<typeof WarehouseMapView>[0]>,
    zones: Array<import("@/hooks/useWarehouseZones").ApiWarehouseZone>,
  ) {
    const onFocusConsumed = jest.fn();
    const onFocusFailed   = jest.fn();

    const renderer = await render(
      <WarehouseMapView
        {...BASE_PROPS}
        zones={zones}
        onFocusConsumed={onFocusConsumed}
        onFocusFailed={onFocusFailed}
      />,
    );
    await flushPromises();

    await act(async () => { fireOnLayout(renderer, 390, 761); });

    computeFitTargetSpy.mockClear();

    // rerender() wraps in act() internally — no extra act() wrapper needed.
    await renderer.rerender(
      <WarehouseMapView
        {...BASE_PROPS}
        zones={zones}
        onFocusConsumed={onFocusConsumed}
        onFocusFailed={onFocusFailed}
        {...extraProps}
      />,
    );

    return { renderer, onFocusConsumed, onFocusFailed };
  }

  it("zone found: pinFocusCxV and pinFocusCyV receive the zone's SVG centre", async () => {
    await mountThenFocus({ focusAisleNum: 5 }, [FOCUS_ZONE]);

    expect(trackedValues.some((sv) => sv.value === EXPECTED_CX)).toBe(true);
    expect(trackedValues.some((sv) => sv.value === EXPECTED_CY)).toBe(true);
  });

  it("zone found: pinFocusModeV is set to 1", async () => {
    await mountThenFocus({ focusAisleNum: 5 }, [FOCUS_ZONE]);

    expect(trackedValues.some((sv) => sv.value === 1)).toBe(true);
  });

  it("zone found: applyFit is called (computeFitTarget called after spy is cleared)", async () => {
    await mountThenFocus({ focusAisleNum: 5 }, [FOCUS_ZONE]);

    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("zone found: onFocusConsumed fires and onFocusFailed does NOT fire", async () => {
    const { onFocusConsumed, onFocusFailed } =
      await mountThenFocus({ focusAisleNum: 5 }, [FOCUS_ZONE]);

    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
    expect(onFocusFailed).not.toHaveBeenCalled();
  });

  it("zone not found: onFocusFailed fires", async () => {
    const { onFocusFailed } =
      await mountThenFocus({ focusAisleNum: 99 }, [FOCUS_ZONE]);

    expect(onFocusFailed).toHaveBeenCalledTimes(1);
  });

  it("zone not found: onFocusConsumed still fires (request consumed even on failure)", async () => {
    const { onFocusConsumed } =
      await mountThenFocus({ focusAisleNum: 99 }, [FOCUS_ZONE]);

    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
  });

  it("zone not found: applyFit is NOT called (computeFitTarget not called after spy is cleared)", async () => {
    await mountThenFocus({ focusAisleNum: 99 }, [FOCUS_ZONE]);

    expect(computeFitTargetSpy).not.toHaveBeenCalled();
  });

  it("focusSectionNum: picks the matching section zone's centre, not the first zone's", async () => {
    const baseFields = {
      aisleId: "7", isInventory: true,
      svgY: 3000, svgHeight: 400,
      sortOrder: 0, createdAt: "", updatedAt: "",
    };
    const ZONE_S1 = { ...baseFields, id: 10, sectionNum: 1, svgX: 100, svgWidth: 200 };
    const ZONE_S2 = { ...baseFields, id: 11, sectionNum: 2, svgX: 500, svgWidth: 200 };
    const expectedCxS2 = ZONE_S2.svgX + ZONE_S2.svgWidth / 2;
    const unexpectedCxS1 = ZONE_S1.svgX + ZONE_S1.svgWidth / 2;

    await mountThenFocus(
      { focusAisleNum: 7, focusSectionNum: 2 },
      [ZONE_S1, ZONE_S2],
    );

    expect(trackedValues.some((sv) => sv.value === expectedCxS2)).toBe(true);
    expect(trackedValues.some((sv) => sv.value === unexpectedCxS1)).toBe(false);
  });
});

// =============================================================================
// Suite 8 — Web unified SVG scene: floor-plan body and zone overlay share one
//           outer SVG, with viewBox normalisation and sanitizer coverage.
//
// Verifies:
//   1. When Platform.OS === "web" and cached xml is non-empty, the floor plan
//      body is injected into a child <g> of the unified outer <Svg>.
//   2. The outer scene owns the normalised viewBox and exact render dimensions.
//   3. A zero-origin source remains in the same normalised scene contract.
//   4. The floor-plan group is a direct child of the unified scene, not a
//      separate surface from the zone overlay.
//   5. The conservative sanitizer strips <script> blocks and on* handlers.
// =============================================================================

describe("web unified SVG scene — floor plan and overlay share one viewport", () => {
  const WEB_INNER_XML = '<path d="M0 0 L100 100"/>';
  const WEB_VB_OFFSET = { x: 50, y: 30, w: 7200, h: 4820 };
  const WEB_CACHED_DATA_OFFSET = {
    uri: "",
    innerXml: WEB_INNER_XML,
    xml: `<svg width="7250" height="4850" viewBox="50 30 7200 4820">${WEB_INNER_XML}</svg>`,
    contentViewBox: WEB_VB_OFFSET,
  };

  beforeEach(() => {
    // Run web platform tests in web mode.
    (require("react-native").Platform as { OS: string }).OS = "web";

    const fpc = require("@/utils/floorPlanCache");
    fpc.getCachedData.mockReturnValue(WEB_CACHED_DATA_OFFSET);
    fpc.hasCachedData.mockReturnValue(true);
    fpc.getCachedHash.mockReturnValue("web-hash");
  });

  // afterEach from the outer scope already restores Platform.OS = "ios" via
  // jest.useRealTimers(), but the Platform.OS write lives inside the outer
  // beforeEach — this inner afterEach ensures the restore happens even when
  // a test throws before the outer afterEach fires.
  afterEach(() => {
    (require("react-native").Platform as { OS: string }).OS = "ios";
  });

  async function mountAndLayout(w: number, h: number) {
    const renderer = await render(<WarehouseMapView {...BASE_PROPS} />);
    await flushPromises();
    await act(async () => { fireOnLayout(renderer, w, h); });
    return renderer;
  }

  function getScene(renderer: Awaited<ReturnType<typeof render>>) {
    const sceneNodes = renderer.root!.queryAll(
      (n) => n.type === "svg" && n.props.viewBox != null,
      { includeSelf: true },
    );
    expect(sceneNodes.length).toBe(1);
    return sceneNodes[0]!;
  }

  function getFloorPlanGroup(renderer: Awaited<ReturnType<typeof render>>) {
    const floorPlanGroups = renderer.root!.queryAll(
      (n) => n.type === "g" && n.props.dangerouslySetInnerHTML != null,
      { includeSelf: true },
    );
    expect(floorPlanGroups.length).toBe(1);
    return floorPlanGroups[0]!;
  }

  it("renders the floor-plan body inside the unified outer <Svg>", async () => {
    const renderer = await mountAndLayout(800, 600);
    const scene = getScene(renderer);
    const floorPlanGroup = getFloorPlanGroup(renderer);
    const html = floorPlanGroup.props.dangerouslySetInnerHTML.__html as string;
    expect(scene.children).toContain(floorPlanGroup);
    expect(html).toContain(WEB_INNER_XML);
  });

  it("normalises the scene viewBox and sets exact render dimensions", async () => {
    const renderer = await mountAndLayout(800, 600);
    const scene = getScene(renderer);
    const html = getFloorPlanGroup(renderer).props.dangerouslySetInnerHTML.__html as string;
    expect(scene.props.viewBox).toBe("0 0 7200 4820");
    expect(scene.props.width).toBe(800);
    const expectedH = 800 / (WEB_VB_OFFSET.w / WEB_VB_OFFSET.h);
    expect(scene.props.height).toBe(expectedH);
    expect(html).not.toContain('viewBox="50 30');
  });

  it("keeps a zero-origin source in the normalised scene contract", async () => {
    const fpc = require("@/utils/floorPlanCache");
    const zeroOriginVB = { x: 0, y: 0, w: 7200, h: 4820 };
    fpc.getCachedData.mockReturnValue({
      ...WEB_CACHED_DATA_OFFSET,
      xml: `<svg viewBox="0 0 7200 4820">${WEB_INNER_XML}</svg>`,
      contentViewBox: zeroOriginVB,
    });

    const renderer = await mountAndLayout(800, 600);
    expect(getScene(renderer).props.viewBox).toBe("0 0 7200 4820");
  });

  it("keeps the injected floor-plan group directly under the unified scene", async () => {
    const renderer = await mountAndLayout(800, 600);
    const scene = getScene(renderer);
    expect(getFloorPlanGroup(renderer).parent).toBe(scene);
  });

  it("strips <script> blocks and on* event handlers from the injected document", async () => {
    const fpc = require("@/utils/floorPlanCache");
    fpc.getCachedData.mockReturnValue({
      ...WEB_CACHED_DATA_OFFSET,
      xml: `<svg viewBox="50 30 7200 4820" onload="evil()"><script>alert(1)</script>${WEB_INNER_XML}</svg>`,
    });

    const renderer = await mountAndLayout(800, 600);
    const html = getFloorPlanGroup(renderer).props.dangerouslySetInnerHTML.__html as string;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onload=");
    expect(html).toContain(WEB_INNER_XML);
  });
});
