/**
 * Regression tests: WarehouseMapView viewport behaviour.
 *
 * Four runtime paths are covered across five suites:
 *
 *   1. Fresh app open (warm cache) → fit-to-screen always runs, regardless of
 *      any previously saved viewport.  AsyncStorage.getItem is NOT called on
 *      mount — the restore path has been intentionally removed so the map is
 *      always centred when the user opens it.
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
 * • AsyncStorage.getItem is a jest.fn() — tests assert it is NOT called on
 *   mount (new semantics).  setItem is tracked to verify background-flush calls
 *   in suite 4.
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
import TestRenderer, { act } from "react-test-renderer";

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

function pressFitButton(renderer: TestRenderer.ReactTestRenderer) {
  const btn = renderer.root.find(
    (n) => n.props.accessibilityLabel === "Fit to screen",
  );
  btn.props.onPress();
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
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });
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

  it("phone (390×761): at least two shared values hold ZOOM_STOPS[0].scale (scale + savedScale)", async () => {
    await mountAndLayout(390, 761);
    const fitScale = ZOOM_STOPS[0].scale;
    const matches = trackedValues.filter((sv) => sv.value === fitScale);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("phone (390×761): AsyncStorage.getItem is NOT called on mount (no restore path)", async () => {
    await mountAndLayout(390, 761);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
  });

  it("phone (390×761): computeFitTarget returns scale === ZOOM_STOPS[0].scale (z0 fit)", async () => {
    await mountAndLayout(390, 761);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    expect(result.scale).toBe(ZOOM_STOPS[0].scale);
  });

  it("iPad (768×960): computeFitTarget is called on mount", async () => {
    await mountAndLayout(768, 960);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("iPad (768×960): at least two shared values hold ZOOM_STOPS[0].scale", async () => {
    await mountAndLayout(768, 960);
    const fitScale = ZOOM_STOPS[0].scale;
    const matches = trackedValues.filter((sv) => sv.value === fitScale);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("iPad (768×960): AsyncStorage.getItem is NOT called on mount", async () => {
    await mountAndLayout(768, 960);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
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

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });
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

  it("phone (390×761): computeFitTarget returns scale === ZOOM_STOPS[0].scale (z0 fit)", async () => {
    await mountFitLayout(390, 761);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    expect(result.scale).toBe(ZOOM_STOPS[0].scale);
  });

  it("phone (390×761): at least two shared values hold ZOOM_STOPS[0].scale after fit", async () => {
    await mountFitLayout(390, 761);
    const fitScale = ZOOM_STOPS[0].scale;
    const matches = trackedValues.filter((sv) => sv.value === fitScale);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("phone (390×761): AsyncStorage.getItem is NOT called on mount (no restore path)", async () => {
    await mountFitLayout(390, 761);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
  });

  it("iPad (768×960): computeFitTarget is called when no stored viewport exists", async () => {
    await mountFitLayout(768, 960);
    expect(computeFitTargetSpy).toHaveBeenCalled();
  });

  it("iPad (768×960): computeFitTarget returns scale === ZOOM_STOPS[0].scale (z0 fit)", async () => {
    await mountFitLayout(768, 960);
    const result = computeFitTargetSpy.mock.results[0]!.value as { scale: number };
    expect(result.scale).toBe(ZOOM_STOPS[0].scale);
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

describe("startup fit — no AsyncStorage.getItem call during mount", () => {
  // Use a scale value clearly different from ZOOM_STOPS[0].scale (1.5) so we
  // can verify the stored scale is ignored and the fit scale is applied instead.
  const STORED_VIEWPORT = JSON.stringify({ s: 4.0, tx: 30, ty: 20 });

  async function mountAndLayout(containerW: number, containerH: number) {
    // Make a stored viewport available — the component must NOT read it.
    mockAsyncStorageGetItem.mockResolvedValue(STORED_VIEWPORT);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });
    await flushPromises();
    await act(async () => {
      fireOnLayout(renderer, containerW, containerH);
    });
    return renderer;
  }

  it("phone (390×761): AsyncStorage.getItem is not called even when a stored viewport exists", async () => {
    await mountAndLayout(390, 761);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
  });

  it("iPad (768×960): AsyncStorage.getItem is not called even when a stored viewport exists", async () => {
    await mountAndLayout(768, 960);
    expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
  });

  it("phone (390×761): fit-to-screen scale is applied (stored s=4.0 is ignored; ZOOM_STOPS[0].scale is used)", async () => {
    await mountAndLayout(390, 761);
    const fitScale = ZOOM_STOPS[0].scale;
    // Stored scale (4.0) must NOT appear in tracked shared values.
    const storedScaleMatches = trackedValues.filter((sv) => sv.value === 4.0);
    expect(storedScaleMatches.length).toBe(0);
    // Fit scale must appear (scale + savedScale).
    const fitScaleMatches = trackedValues.filter((sv) => sv.value === fitScale);
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

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });
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
    await act(async () => { renderer.unmount(); });
  });

  it("does NOT call AsyncStorage.setItem when backgrounded with no pending write", async () => {
    mockAsyncStorageGetItem.mockResolvedValue(null);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });
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

    await act(async () => { renderer.unmount(); });
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
  //
  // The startup-fit useEffect fires on mount and keeps pendingFit = true (no
  // AsyncStorage.getItem is called).  The fit-to-screen path runs once both
  // contentVBRef and containerW are populated.
  //
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
  //
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

      // The startup-fit useEffect does NOT call AsyncStorage.getItem on mount.
      // pendingFit stays true so the fit-to-screen path runs normally.
      expect(mockAsyncStorageGetItem).not.toHaveBeenCalled();
    },
  );

});
