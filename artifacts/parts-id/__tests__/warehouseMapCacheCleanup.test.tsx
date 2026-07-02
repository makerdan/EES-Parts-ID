/**
 * Integration test: WarehouseMapView mount effect → cleanStaleCacheDirs
 *
 * Verifies that the tile-pyramid stale-cache cleanup is actually triggered
 * from the map's mount effect.  If the call site is accidentally removed or
 * gated incorrectly, stale PNG tiles from a previous admin floor-plan upload
 * will silently persist on device.  This test catches that regression at the
 * call site rather than in isolation.
 *
 * Two paths are covered:
 *
 *   A) Cold-start with a pre-cached hash (getCachedHash returns a string on the
 *      initial render) — svgHash initialises non-empty so the cleanup effect
 *      fires immediately on mount.
 *
 *   B) Null → string transition (getCachedHash is null on mount, then the
 *      async SVG-load effect resolves, setSvgHash is called with the fetched
 *      hash, and the cleanup effect fires in reaction to the state change).
 *
 * Mock strategy
 * ─────────────
 * Heavy native modules are mocked inline so WarehouseMapView can be imported
 * and rendered by react-test-renderer.
 *
 * @/utils/floorPlanCache is mocked with controllable getCachedHash /
 * getCachedData / hasCachedData helpers.  For path A, hasCachedData() returns
 * true so the SVG-load useEffect returns early (no fetch needed).  For path B,
 * hasCachedData() starts false, fetch is stubbed, and the setCached mock
 * side-effects the getCachedData / getCachedHash mocks so the async effect
 * picks up the resolved hash exactly as the production code does.
 *
 * @/utils/tilePyramidCache.cleanStaleCacheDirs is the spy under test.
 */

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
// __esModule: true tells ts-jest's interop helper that `.default` is the real
// export, so `import AsyncStorage from "..."` resolves to the inner object.
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    multiGet: jest.fn(() => Promise.resolve([])),
  },
}));

// ─── @/utils/appAuth ─────────────────────────────────────────────────────────
// WarehouseMapView uses fetchWithAuth (not raw fetch) for all server requests.
// Delegating to global.fetch lets per-test stubs control the responses.
jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: jest.fn((url: string, init?: RequestInit) =>
    (global.fetch as typeof fetch)(url, init),
  ),
  setAppToken:    jest.fn(),
  setAdminToken:  jest.fn(),
  getAuthHeaders: jest.fn(() => ({})),
  setAuthTokenGetter: jest.fn(),
}));

// ─── @/utils/apiBase ─────────────────────────────────────────────────────────
// Return an empty API_BASE so the server-hash polling setInterval in
// WarehouseMapView (guarded by `if (!API_BASE) return`) is never registered.
// Without this mock the interval leaks into Jest and forces --forceExit.
jest.mock("@/utils/apiBase", () => ({ API_BASE: "" }));

// ─── @/utils/floorPlan ────────────────────────────────────────────────────────
jest.mock("@/utils/floorPlan", () => ({
  warmupTiles: jest.fn(() => Promise.resolve()),
  tileApiUrl: jest.fn((z: number, x: number, y: number) =>
    `/floor-plan/tiles/${z}/${x}/${y}.png`),
}));

// ─── @/utils/tilePyramidCache ─────────────────────────────────────────────────
const mockCleanStaleCacheDirs = jest.fn(() => Promise.resolve());
jest.mock("@/utils/tilePyramidCache", () => ({
  cleanStaleCacheDirs: mockCleanStaleCacheDirs,
  fetchTile: jest.fn(() => Promise.resolve("")),
  prefetchZoomLevel: jest.fn(() => Promise.resolve()),
}));

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────
const mockGetCachedHash = jest.fn<string | null, []>();
const mockHasCachedData = jest.fn<boolean, []>();
const mockGetCachedData = jest.fn<{ uri: string; innerXml: string; xml: string } | null, []>();
const mockSetCached = jest.fn<void, [string, { uri: string; innerXml: string; xml: string }]>();
jest.mock("@/utils/floorPlanCache", () => ({
  getCachedHash: mockGetCachedHash,
  getCachedData: mockGetCachedData,
  hasCachedData: mockHasCachedData,
  getIfValid: jest.fn(() => null),
  initPersistRead: jest.fn(() => Promise.resolve()),
  resetForServerUpdate: jest.fn(),
  setCached: mockSetCached,
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

// Use fake timers so the 3 s setEmptyDismissed setTimeout (WarehouseMapView
// line ~759) never fires on the real event loop during these tests.  Without
// this, the timer outlives every test and triggers an "update was not wrapped
// in act()" warning plus a "Force exiting Jest" hang.
//
// setImmediate and nextTick are kept real because Path B's polling loop relies
// on them to let microtask continuations advance step-by-step.
beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Restore Platform to native (ios) so the filesystem branch is exercised.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require("react-native").Platform as { OS: string }).OS = "ios";
});

// ─────────────────────────────────────────────────────────────────────────────
// Path A: hash already cached at mount (getCachedHash returns a string)
// ─────────────────────────────────────────────────────────────────────────────

describe("cleanStaleCacheDirs call site — hash present at mount", () => {
  beforeEach(() => {
    // hasCachedData() = true → SVG-load useEffect returns early (no fetch).
    mockHasCachedData.mockReturnValue(true);
    mockGetCachedData.mockReturnValue(null);
  });

  it("calls cleanStaleCacheDirs with the correct hash when getCachedHash returns a string on mount", async () => {
    mockGetCachedHash.mockReturnValue("abc123");

    await act(async () => {
      TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    expect(mockCleanStaleCacheDirs).toHaveBeenCalledTimes(1);
    expect(mockCleanStaleCacheDirs).toHaveBeenCalledWith("abc123");
  });

  it("does NOT call cleanStaleCacheDirs when getCachedHash returns null at mount", async () => {
    mockGetCachedHash.mockReturnValue(null);

    await act(async () => {
      TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    expect(mockCleanStaleCacheDirs).not.toHaveBeenCalled();
  });

  it("does NOT call cleanStaleCacheDirs on web even when a hash is available", async () => {
    mockGetCachedHash.mockReturnValue("abc123");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require("react-native").Platform as { OS: string }).OS = "web";

    await act(async () => {
      TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    expect(mockCleanStaleCacheDirs).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path B: null → string transition (hash resolves after async SVG load)
// ─────────────────────────────────────────────────────────────────────────────
//
// This covers the key regression scenario: the floor plan is not cached yet
// when WarehouseMapView mounts (getCachedHash = null, hasCachedData = false).
// The SVG-load effect runs, fetches the floor plan, calls setCached(), and
// then setSvgHash() is called with the resolved hash.  The cleanup effect must
// fire in response to that state update.
//
// jest.isolateModules ensures a fresh WarehouseMapView module instance with a
// clean _svgLoadPromise for each test, so the async load path actually runs.

describe("cleanStaleCacheDirs call site — null → string hash transition", () => {
  it("calls cleanStaleCacheDirs when hash resolves from the async SVG load (null → 'loaded-hash')", async () => {
    // jest.isolateModules gives a fresh WarehouseMapView module instance so
    // the module-level _svgLoadPromise singleton is re-initialized.  We
    // configure fetchWithAuth BEFORE requiring WarehouseMapView, so the
    // server-load path (_loadFloorPlanFromServer) sees the mocked responses
    // and resolves _svgLoadPromise with the server hash instead of the bundle
    // fallback hash.
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(async () => {
        try {
          // Configure fetchWithAuth responses BEFORE WarehouseMapView loads.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const appAuth = require("@/utils/appAuth");
          appAuth.fetchWithAuth
            // GET /floor-plan/meta from _loadFloorPlanFromServer.
            // (The server-hash polling setInterval is never registered because
            // @/utils/apiBase is mocked with API_BASE:"" at the top of this
            // file, so the polling effect's `if (!API_BASE) return` fires
            // immediately — no fetchWithAuth call from that path.)
            .mockResolvedValueOnce({
              ok: true,
              json: async () => ({ hash: "loaded-hash" }),
            })
            // GET /floor-plan/svg from _loadFloorPlanFromServer → minimal SVG
            .mockResolvedValueOnce({
              ok: true,
              text: async () => "<svg/>",
            })
            // Any further call fails (should not be reached)
            .mockResolvedValue({ ok: false });

          // Configure floorPlanCache for cold-cache path.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const fpc = require("@/utils/floorPlanCache");
          fpc.getCachedHash.mockReturnValue(null);
          fpc.hasCachedData.mockReturnValue(false);
          fpc.getCachedData.mockReturnValue(null);
          const RESOLVED_DATA = { uri: "/floor-plan/svg", innerXml: "", xml: "<svg/>" };
          fpc.setCached.mockImplementationOnce((hash: string) => {
            fpc.getCachedHash.mockReturnValue(hash);
            fpc.getCachedData.mockReturnValue(RESOLVED_DATA);
            fpc.hasCachedData.mockReturnValue(true);
          });

          // Grab the isolated cleanStaleCacheDirs instance for assertions.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const tpc = require("@/utils/tilePyramidCache");

          // NOW require WarehouseMapView so _svgLoadPromise is initialized with
          // the patched fetchWithAuth already in place.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { WarehouseMapView: WMV } = require("@/components/WarehouseMapView");
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const TR = require("react-test-renderer");
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const React_ = require("react");

          // With IS_REACT_ACT_ENVIRONMENT unset (false), TR.act(async cb) does
          // NOT properly await async callbacks — it calls flushPassiveEffects()
          // synchronously and returns a fake synchronously-resolving thenable,
          // so the async cb runs in the background after act() exits.
          //
          // Strategy:
          //  1. Mount with act() so effects are started (SVG-load async IIFE).
          //  2. Poll with setImmediate outside act(): each yield lets microtask
          //     continuations advance one step.  React's scheduler posts state
          //     updates via MessageChannel (macro task, poll phase), which fires
          //     before our check-phase setImmediate within the same iteration.
          //     Stop once setCached is detected.
          //  3. One more setImmediate to guarantee React's MessageChannel
          //     re-render has fired (poll) and pendingPassiveEffectsLanes is set.
          //  4. Final act() calls flushPassiveEffects() which directly reads
          //     pendingPassiveEffectsLanes and runs the svgHash effect
          //     (→ cleanStaleCacheDirs) without going through the scheduler.
          await TR.act(async () => {
            TR.create(React_.createElement(WMV, BASE_PROPS));
          });

          for (let i = 0; i < 20; i++) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise<void>(r => setImmediate(r));
            if (mockSetCached.mock.calls.length > 0) break;
          }

          // Ensure the MessageChannel re-render commit has set
          // pendingPassiveEffectsLanes before the act() below flushes it.
          await new Promise<void>(r => setImmediate(r));

          // Flush passive effects (svgHash useEffect → cleanStaleCacheDirs).
          await TR.act(async () => {});

          // After the load resolves, setSvgHash("loaded-hash") fires which
          // triggers the cleanStaleCacheDirs effect.
          expect(tpc.cleanStaleCacheDirs).toHaveBeenCalledTimes(1);
          expect(tpc.cleanStaleCacheDirs).toHaveBeenCalledWith("loaded-hash");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("does NOT call cleanStaleCacheDirs when the async load fails (hash stays null)", async () => {
    // Note: _svgLoadPromise in WarehouseMapView is already resolved from the
    // previous test, so loadSvgAsset() returns immediately.  getCachedData()
    // is reset to null in this test's setup so setSvgHash() is never called.
    mockGetCachedHash.mockReturnValue(null);
    mockHasCachedData.mockReturnValue(false);
    mockGetCachedData.mockReturnValue(null);

    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));

    // Enable the React act() environment for this test only so that state
    // updates from the async IIFE (which runs after the first await inside
    // act()) are tracked by React's act() queue and do not produce an
    // "environment not configured to support act()" console.error.
    const g = global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => {
        TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
        // One macrotask boundary (setImmediate) lets the SVG-load async IIFE
        // drain its entire microtask chain — _persistReadPromise resolves →
        // fetch rejects → catch chain resolves — before this callback returns.
        // The IIFE's `if (cancelled) return` guard fires at that point (cancelled
        // is false; the component is still mounted) and setSvgLoading(false) is
        // called while IS_REACT_ACT_ENVIRONMENT is true and IS_ACT_ACTIVE is
        // set, so React tracks it without logging a warning.
        await new Promise<void>(r => setImmediate(r));
        // A second boundary ensures effects flushed by act() after the first
        // setImmediate (e.g. the passive-effect re-run) also complete before
        // we return from the act() callback.
        await new Promise<void>(r => setImmediate(r));
      });
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      global.fetch = originalFetch;
    }

    expect(mockCleanStaleCacheDirs).not.toHaveBeenCalled();
  });
});
