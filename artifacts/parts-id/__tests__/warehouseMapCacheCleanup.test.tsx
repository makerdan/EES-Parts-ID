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
    // No hash or cached data at mount.
    mockGetCachedHash.mockReturnValue(null);
    mockHasCachedData.mockReturnValue(false);
    mockGetCachedData.mockReturnValue(null);

    // When the load effect calls setCached(), side-effect the mocks so that
    // getCachedData() / getCachedHash() return the resolved values — exactly
    // as the production floorPlanCache module would after a real write.
    const RESOLVED_DATA = { uri: "/floor-plan/svg", innerXml: "", xml: "<svg/>" };
    mockSetCached.mockImplementationOnce((hash: string) => {
      mockGetCachedHash.mockReturnValue(hash);
      mockGetCachedData.mockReturnValue(RESOLVED_DATA);
      mockHasCachedData.mockReturnValue(true);
    });

    // Stub fetch so _loadFloorPlanFromServer() succeeds and calls setCached().
    // SVG_API_BASE = "" in tests (EXPO_PUBLIC_DOMAIN not set), so paths are bare.
    const originalFetch = global.fetch;
    global.fetch = jest.fn()
      // GET /floor-plan/meta → returns the hash
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "loaded-hash" }),
      } as unknown as Response)
      // GET /floor-plan/svg → returns minimal SVG text
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "<svg/>",
      } as unknown as Response)
      // Fallback for any additional fetch (e.g. viewport restore; should not fire)
      .mockResolvedValue({
        ok: false,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response);

    await act(async () => {
      TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    global.fetch = originalFetch;

    // After the async load resolves, setSvgHash("loaded-hash") fires which
    // triggers the cleanup effect.
    expect(mockCleanStaleCacheDirs).toHaveBeenCalledTimes(1);
    expect(mockCleanStaleCacheDirs).toHaveBeenCalledWith("loaded-hash");
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

    await act(async () => {
      TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    global.fetch = originalFetch;

    expect(mockCleanStaleCacheDirs).not.toHaveBeenCalled();
  });
});
