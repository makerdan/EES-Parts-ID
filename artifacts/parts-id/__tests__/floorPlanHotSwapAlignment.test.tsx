/**
 * Regression test: zone overlay stays aligned after a mid-session floor-plan hot-swap
 *
 * Scenario: WarehouseMapView is mounted with SVG A already cached.  While the
 * component is live, an admin uploads a new floor plan on the server.  The ETag
 * poll detects the new hash and increments serverHashChanged, which re-runs the
 * SVG-load effect.  The component fetches SVG B, re-parses contentVB, and
 * rewrites normalizedSvgXml — the zone overlay <Svg> viewBox must match SVG B's
 * dimensions and SvgXml must receive the origin-normalised string for SVG B.
 *
 * SVG A: viewBox="0 0 6000 4000"   (zero origin — no rewrite needed)
 * SVG B: viewBox="100 200 5000 3000" (non-zero origin — must be rewritten to
 *                                     "0 0 5000 3000" so zones align)
 *
 * Mock strategy
 * ─────────────
 * • floorPlanCache is mocked with a mutable state object that mirrors the real
 *   module's behaviour: resetForServerUpdate clears it, setCached populates it.
 * • fetchWithAuth is given per-call responses in sequence:
 *     call 1 — ETag poll (immediate on mount): /floor-plan/meta → "hash-a"
 *     call 2 — ETag poll (60 s interval): /floor-plan/meta → "hash-b"
 *     call 3 — SVG reload (_loadFloorPlanFromServer meta): /floor-plan/meta → "hash-b"
 *     call 4 — SVG reload (_loadFloorPlanFromServer svg):  /floor-plan/svg   → SVG_B
 * • jest.useFakeTimers controls the 60-second setInterval.
 * • SvgXml renders a "svgxml-probe" host element that exposes its xml prop so
 *   the test can inspect normalizedSvgXml without any module-level side-effects.
 * • onLayout is fired with real dimensions so the component renders past the
 *   containerW === 0 early-return and the zone overlay <Svg> is mounted.
 */

// React 19 requires IS_REACT_ACT_ENVIRONMENT = true for act() to flush state updates.
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// ─── react-native-reanimated ──────────────────────────────────────────────────
// __esModule: true is required (Trap 1 in memory): without it ts-jest's CJS
// interop assigns the entire module object as Animated.default, making
// Animated.View undefined and throwing "Element type is invalid" as soon as
// containerW > 0 causes the tile-render branch to be entered.

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
// SvgXml renders a "svgxml-probe" host element so the test can find it in the
// renderer tree and inspect the xml prop (= normalizedSvgXml from the component).

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
    SvgXml: ({ xml, ...rest }: { xml: string } & Record<string, unknown>) =>
      React.createElement("svgxml-probe", { xml, ...rest }),
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

const mockFetchWithAuth = jest.fn();
jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  setAuthTokenGetter: jest.fn(),
  onUnauthorized: jest.fn(),
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
// Mutable state object mirrors the real module.
// resetForServerUpdate clears it; setCached populates it; getIfValid does
// hash comparison — matching production semantics without the AsyncStorage layer.

const SVG_A_XML = '<svg viewBox="0 0 6000 4000">floor-plan-a</svg>';
const SVG_A_CONTENT_VB = { x: 0, y: 0, w: 6000, h: 4000 };
const SVG_B_XML = '<svg viewBox="100 200 5000 3000">floor-plan-b</svg>';
const SVG_B_CONTENT_VB = { x: 100, y: 200, w: 5000, h: 3000 };

interface MockCacheEntry {
  xml: string;
  innerXml: string;
  uri: string;
  contentViewBox?: { x: number; y: number; w: number; h: number };
}

let _mockCache: MockCacheEntry | null = {
  xml: SVG_A_XML,
  innerXml: "",
  uri: "",
  contentViewBox: SVG_A_CONTENT_VB,
};
let _mockHash: string | null = "hash-a";

jest.mock("@/utils/floorPlanCache", () => ({
  getCachedData: jest.fn(() => _mockCache),
  getCachedHash: jest.fn(() => _mockHash),
  hasCachedData: jest.fn(() => _mockCache !== null),
  getIfValid: jest.fn((hash: string) =>
    _mockCache !== null && _mockHash === hash ? _mockCache : null,
  ),
  initPersistRead: jest.fn(() => Promise.resolve()),
  resetForServerUpdate: jest.fn(() => {
    _mockCache = null;
    _mockHash = null;
  }),
  setCached: jest.fn((hash: string, data: MockCacheEntry) => {
    _mockCache = data;
    _mockHash = hash;
  }),
  setFallbackEmpty: jest.fn(),
}));

// ─── Component and utilities ──────────────────────────────────────────────────

import { WarehouseMapView } from "@/components/WarehouseMapView";

// ─── Constants and helpers ────────────────────────────────────────────────────

const NOOP = jest.fn();
const BASE_PROPS = {
  zones: [],
  zonesLoading: false,
  zonesError: false,
  onZonesRetry: NOOP,
  onZoneTap: NOOP,
};

function fireOnLayout(renderer: TestRenderer.ReactTestRenderer, width: number, height: number) {
  const nodes = renderer.root.findAll(
    (n) => typeof n.props.onLayout === "function",
    { deep: true },
  );
  if (nodes.length === 0) throw new Error("No onLayout node found");
  nodes[0].props.onLayout({ nativeEvent: { layout: { width, height, x: 0, y: 0 } } });
}

/** Flush enough microtask ticks to drain async effect chains. */
async function flushPromises(ticks = 12) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

/** Find the zone overlay <Svg> element by its absoluteFill style. */
function findOverlaySvgViewBox(renderer: TestRenderer.ReactTestRenderer): string | undefined {
  const svgs = renderer.root.findAll((n) => n.type === "svg", { deep: true });
  // The zone overlay Svg has StyleSheet.absoluteFill + viewBox prop.
  const overlay = svgs.find((n) => n.props.viewBox !== undefined);
  return overlay?.props.viewBox as string | undefined;
}

/** Return the xml prop from the most-recently-rendered SvgXml probe element. */
function findSvgXmlProp(renderer: TestRenderer.ReactTestRenderer): string | undefined {
  const probes = renderer.root.findAll(
    (n) => (n.type as unknown) === "svgxml-probe",
    { deep: true },
  );
  if (probes.length === 0) return undefined;
  return probes[probes.length - 1]!.props.xml as string;
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();

  // Reset mutable cache state to SVG A for each test.
  _mockCache = { xml: SVG_A_XML, innerXml: "", uri: "", contentViewBox: SVG_A_CONTENT_VB };
  _mockHash = "hash-a";

  // Reset all jest.fn() mocks (clears call counts etc.) but preserve the mock
  // implementations registered by jest.mock() above.
  jest.clearAllMocks();
  mockFetchWithAuth.mockResolvedValue({ ok: false });

  // Restore mutable cache closures after clearAllMocks resets the .fn() spies.
  const fpc = require("@/utils/floorPlanCache");
  fpc.getCachedData.mockImplementation(() => _mockCache);
  fpc.getCachedHash.mockImplementation(() => _mockHash);
  fpc.hasCachedData.mockImplementation(() => _mockCache !== null);
  fpc.getIfValid.mockImplementation((hash: string) =>
    _mockCache !== null && _mockHash === hash ? _mockCache : null,
  );
  fpc.resetForServerUpdate.mockImplementation(() => {
    _mockCache = null;
    _mockHash = null;
  });
  fpc.setCached.mockImplementation((hash: string, data: MockCacheEntry) => {
    _mockCache = data;
    _mockHash = hash;
  });

  (require("react-native").Platform as { OS: string }).OS = "ios";
});

afterEach(() => {
  jest.useRealTimers();
});

// =============================================================================
// Suite: floor-plan hot-swap alignment
// =============================================================================

describe("floor-plan hot-swap — zone overlay stays aligned after mid-session reload", () => {

  /**
   * Mount WarehouseMapView with SVG A cached, fire onLayout so the full render
   * tree is visible (containerW > 0), then simulate an admin uploading a new
   * floor plan (hash-b → SVG B with a non-zero viewBox origin).
   *
   * Returns the renderer after the hot-swap has settled.
   */
  async function mountAndHotSwap() {
    // ETag poll sequence:
    //   call 1 (immediate): /floor-plan/meta → hash-a (baseline)
    //   call 2 (60 s):      /floor-plan/meta → hash-b (triggers reload)
    // SVG reload sequence (_loadFloorPlanFromServer):
    //   call 3: /floor-plan/meta → hash-b
    //   call 4: /floor-plan/svg  → SVG_B xml
    mockFetchWithAuth
      // call 1: ETag poll, first check (baseline)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "hash-a" }),
      })
      // call 2: ETag poll, second check after 60 s interval
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "hash-b" }),
      })
      // call 3: SVG reload — _loadFloorPlanFromServer meta
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "hash-b" }),
      })
      // call 4: SVG reload — _loadFloorPlanFromServer svg
      .mockResolvedValueOnce({
        ok: true,
        text: async () => SVG_B_XML,
      })
      // Fallback: any further calls fail gracefully
      .mockResolvedValue({ ok: false });

    let renderer!: TestRenderer.ReactTestRenderer;

    // Mount — hasCachedData() = true so the SVG load effect returns early (no
    // network fetch needed).  The ETag poll fires its first checkServerHash.
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
    });

    // Drain the initial ETag poll microtasks (call 1 → establishes baseline).
    await flushPromises(6);

    // Fire onLayout so containerW > 0; the full render tree (SvgXml + Svg
    // overlay) becomes visible.
    await act(async () => {
      fireOnLayout(renderer, 390, 761);
    });

    // Advance fake time by 60 s to trigger the setInterval ETag poll (call 2
    // → hash-b detected → setServerHashChanged fires).
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    // Drain the async chain: ETag poll resolves → React schedules a re-render
    // (setServerHashChanged) → SVG reload effect runs (calls 3 & 4) →
    // setCached → setSvgXml → contentVB parse effect → setContentVB.
    await flushPromises(16);

    return renderer;
  }

  // ── Test 1 ─────────────────────────────────────────────────────────────────

  it("zone overlay <Svg> viewBox uses SVG B's dimensions after hot-swap", async () => {
    const renderer = await mountAndHotSwap();

    const viewBox = findOverlaySvgViewBox(renderer);
    expect(viewBox).toBeDefined();
    // SVG B has contentVB.w=5000 and contentVB.h=3000.
    expect(viewBox).toBe(`0 0 ${SVG_B_CONTENT_VB.w} ${SVG_B_CONTENT_VB.h}`);
  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────

  it("zone overlay <Svg> viewBox does NOT still use SVG A's dimensions after hot-swap", async () => {
    const renderer = await mountAndHotSwap();

    const viewBox = findOverlaySvgViewBox(renderer);
    // Must NOT still be SVG A's dimensions.
    expect(viewBox).not.toBe(`0 0 ${SVG_A_CONTENT_VB.w} ${SVG_A_CONTENT_VB.h}`);
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────

  it("SvgXml receives the origin-normalised string for SVG B after hot-swap", async () => {
    const renderer = await mountAndHotSwap();

    const xml = findSvgXmlProp(renderer);
    expect(xml).toBeDefined();
    // The viewBox rewrite must be present: "100 200 5000 3000" → "0 0 5000 3000".
    expect(xml).toContain('viewBox="0 0 5000 3000"');
  });

  // ── Test 4 ─────────────────────────────────────────────────────────────────

  it("SvgXml does not receive SVG A's xml string after hot-swap", async () => {
    const renderer = await mountAndHotSwap();

    const xml = findSvgXmlProp(renderer);
    // Must not be SVG A's content.
    expect(xml).not.toContain("floor-plan-a");
  });

  // ── Test 5 ─────────────────────────────────────────────────────────────────

  it("SvgXml receives the SVG B content body after hot-swap", async () => {
    const renderer = await mountAndHotSwap();

    const xml = findSvgXmlProp(renderer);
    expect(xml).toBeDefined();
    // The SVG B content must be present (body text survives the viewBox rewrite).
    expect(xml).toContain("floor-plan-b");
  });

  // ── Test 6 ─────────────────────────────────────────────────────────────────

  it("contentVB is re-derived from SVG B, not left stale from SVG A", async () => {
    const renderer = await mountAndHotSwap();

    // Both the zone overlay viewBox and the SvgXml xml must reflect SVG B's
    // dimensions, confirming contentVB was not left stale mid-session.
    const viewBox = findOverlaySvgViewBox(renderer);
    const xml = findSvgXmlProp(renderer);

    expect(viewBox).toBe(`0 0 ${SVG_B_CONTENT_VB.w} ${SVG_B_CONTENT_VB.h}`);
    expect(xml).toContain(`viewBox="0 0 ${SVG_B_CONTENT_VB.w} ${SVG_B_CONTENT_VB.h}"`);
  });
});
