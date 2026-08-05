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
 * and rendered by @testing-library/react-native.
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
import { render, act } from "@testing-library/react-native";

// ─── react-native-reanimated ──────────────────────────────────────────────────
jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());

// ─── react-native-gesture-handler ────────────────────────────────────────────
// Handled automatically by moduleNameMapper in jest.config.js → __mocks__/react-native-gesture-handler.js

// ─── react-native-svg ────────────────────────────────────────────────────────
jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── expo-asset ──────────────────────────────────────────────────────────────
jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());

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

// ─── @expo/vector-icons ───────────────────────────────────────────────────────
jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

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
    // getCachedData() must return non-null AND have a non-empty innerXml so the
    // SVG-load useEffect hits the fast-path early return (`isAdequate = true`)
    // on BOTH native and web.  A stale entry with innerXml:"" would fail the
    // isAdequate check on web (the task-706 web-cache-heal guard) and cause
    // loadSvgAsset() to run, polluting _svgLoadPromise and breaking Path B.
    const CACHED: { uri: string; innerXml: string; xml: string } = {
      uri: "x", innerXml: "<g/>", xml: "<svg><g/></svg>",
    };
    mockHasCachedData.mockReturnValue(true);
    mockGetCachedData.mockReturnValue(CACHED);
  });

  it("calls cleanStaleCacheDirs with the correct hash when getCachedHash returns a string on mount", async () => {
    mockGetCachedHash.mockReturnValue("abc123");

    // render() in RTLRN v14 is async and already wraps in act() internally.
    await render(<WarehouseMapView {...BASE_PROPS} />);

    expect(mockCleanStaleCacheDirs).toHaveBeenCalledTimes(1);
    expect(mockCleanStaleCacheDirs).toHaveBeenCalledWith("abc123");
  });

  it("does NOT call cleanStaleCacheDirs when getCachedHash returns null at mount", async () => {
    mockGetCachedHash.mockReturnValue(null);

    await render(<WarehouseMapView {...BASE_PROPS} />);

    expect(mockCleanStaleCacheDirs).not.toHaveBeenCalled();
  });

  it("does NOT call cleanStaleCacheDirs on web even when a hash is available", async () => {
    mockGetCachedHash.mockReturnValue("abc123");
    // On web the fast-path also requires a non-empty innerXml to count as
    // adequate; provide one so the load effect still returns early and leaves
    // the module-level _svgLoadPromise singleton null for Path B.
    mockGetCachedData.mockReturnValue({ uri: "", innerXml: "<g/>", xml: "<svg/>" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require("react-native").Platform as { OS: string }).OS = "web";

    await render(<WarehouseMapView {...BASE_PROPS} />);

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
// WHY no jest.isolateModules here:
//   Path A tests all set hasCachedData()=true, so the SVG-load useEffect hits
//   "if (!isServerUpdate && hasCachedData()) return" and exits before calling
//   loadSvgAsset().  The module-level _svgLoadPromise singleton therefore
//   remains null when Path B begins.  We can mount the top-level
//   WarehouseMapView import directly and let the async load path run normally.

describe("cleanStaleCacheDirs call site — null → string hash transition", () => {
  it("calls cleanStaleCacheDirs when hash resolves from the async SVG load (null → 'loaded-hash')", async () => {
    // Cold-cache setup: no cached data on mount so the async load runs.
    mockGetCachedHash.mockReturnValue(null);
    mockHasCachedData.mockReturnValue(false);
    mockGetCachedData.mockReturnValue(null);
    const RESOLVED_DATA = { uri: "/floor-plan/svg", innerXml: "", xml: "<svg/>" };
    // When setCached is called with the fetched hash, update the cache mocks
    // so subsequent getCachedData() / getCachedHash() calls return the new data.
    mockSetCached.mockImplementationOnce((hash: string) => {
      mockGetCachedHash.mockReturnValue(hash);
      mockGetCachedData.mockReturnValue(RESOLVED_DATA);
      mockHasCachedData.mockReturnValue(true);
    });

    // Stub the two fetchWithAuth calls made by _loadFloorPlanFromServer:
    //   1. GET /floor-plan/meta  → { hash: "loaded-hash" }
    //   2. GET /floor-plan/svg   → "<svg/>"
    // mockResolvedValueOnce takes priority over the factory's default
    // implementation (which delegates to global.fetch) for those calls.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fetchWithAuth } = require("@/utils/appAuth") as { fetchWithAuth: jest.Mock };
    fetchWithAuth
      .mockResolvedValueOnce({ ok: true, json: async () => ({ hash: "loaded-hash" }) })
      .mockResolvedValueOnce({ ok: true, text: async () => "<svg/>" })
      .mockResolvedValue({ ok: false });

    // Keep IS_REACT_ACT_ENVIRONMENT=true through the full async sequence.
    // render() sets it to true internally and restores to its previous value
    // afterward.  Pre-setting it ensures the restored value is also true, so
    // React does not warn about unwrapped state updates in the setImmediate
    // polling ticks that follow render().
    const g = global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
    const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      // render() in RTLRN v14 is async and wraps internally in act(), which
      // starts the component's mount effects (SVG-load async IIFE).
      await render(<WarehouseMapView {...BASE_PROPS} />);

      // Poll with setImmediate outside act(): each yield lets microtask
      // continuations advance one step.  React's scheduler posts state
      // updates via MessageChannel (macro task, poll phase), which fires
      // before the check-phase setImmediate within the same iteration.
      // Stop once setCached is detected (at most 20 ticks).
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>(r => setImmediate(r));
        if (mockSetCached.mock.calls.length > 0) break;
      }

      // One extra boundary to let the MessageChannel commit finish setting
      // pendingPassiveEffectsLanes before the act() flush below.
      await new Promise<void>(r => setImmediate(r));

      // Flush passive effects so the svgHash useEffect → cleanStaleCacheDirs
      // call is committed.
      await act(async () => {});
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }

    expect(mockCleanStaleCacheDirs).toHaveBeenCalledTimes(1);
    expect(mockCleanStaleCacheDirs).toHaveBeenCalledWith("loaded-hash");
  });

  it("does NOT call cleanStaleCacheDirs when the async load fails (hash stays null)", async () => {
    // _svgLoadPromise is already resolved from the previous test (the server
    // load succeeded and set it).  loadSvgAsset() therefore returns immediately
    // without making any network calls.  getCachedData() is reset to null here
    // so getSvgHash() stays "" and the cleanStaleCacheDirs effect never fires.
    mockGetCachedHash.mockReturnValue(null);
    mockHasCachedData.mockReturnValue(false);
    mockGetCachedData.mockReturnValue(null);

    // global.fetch rejection is a belt-and-suspenders guard; loadSvgAsset()
    // returns the already-resolved promise so fetch is never actually called.
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));

    // Same IS_REACT_ACT_ENVIRONMENT guard as the previous test.
    const g = global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
    const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await render(<WarehouseMapView {...BASE_PROPS} />);
      // Two setImmediate ticks drain the async IIFE microtask chain.
      await new Promise<void>(r => setImmediate(r));
      await new Promise<void>(r => setImmediate(r));
      await act(async () => {});
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      global.fetch = originalFetch;
    }

    expect(mockCleanStaleCacheDirs).not.toHaveBeenCalled();
  });
});
