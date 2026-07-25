/**
 * Regression test: web floor-plan colour-invert filter is dark-mode-only.
 *
 * Task #488 fixed the web floor plan disappearing in light mode.  An
 * `invert(1) brightness(0.88)` CSS filter was being applied unconditionally to
 * the web floor-plan `<g>` element (rendered via dangerouslySetInnerHTML inside
 * the zone-overlay <Svg>), turning the dark SVG artwork near-white against the
 * light background.  The fix gates the filter on the `isDark` flag:
 *
 *     style: { filter: isDark ? "invert(1) brightness(0.88)" : "none" }
 *
 * These tests render the web path of WarehouseMapView and assert the filter is
 * present ONLY in dark mode.  If the filter is ever reapplied unconditionally,
 * the light-mode assertion (filter === "none") fails.
 *
 * Web-path requirements (differs from the native WarehouseMapView.test.tsx):
 *   • Platform.OS is forced to "web" so the `Platform.OS === "web" && innerXml`
 *     branch renders the floor-plan <g>.
 *   • getCachedData() returns a non-empty innerXml so `innerXml` state is truthy
 *     on mount (the <g> only renders when innerXml is non-empty).
 *   • useColorScheme (from the react-native mock) is overridden per test to
 *     drive `isDark` — the component reads the RAW system scheme for isDark,
 *     not the effective/settings scheme.
 *   • dompurify is mocked with a passthrough sanitize so it works in the node
 *     (non-jsdom) test environment.
 */

// React 19 requires IS_REACT_ACT_ENVIRONMENT = true for act() to flush
// synchronous state updates triggered by onLayout.
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

// ─── dompurify ───────────────────────────────────────────────────────────────
// The component calls DOMPurify.sanitize on the floor-plan innerXml.  In the
// node (non-jsdom) test environment the real default export is a window-less
// factory whose .sanitize is not callable, so mock it with a passthrough.

jest.mock("dompurify", () => ({
  __esModule: true,
  default: { sanitize: (s: string) => s },
}));

// ─── @/utils/apiBase ─────────────────────────────────────────────────────────

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

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(() => Promise.resolve(null)),
    setItem:    jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    multiGet:   jest.fn(() => Promise.resolve([])),
  },
}));

// ─── @/utils/appAuth ─────────────────────────────────────────────────────────

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
// innerXml is non-empty so the web floor-plan <g> renders on mount.

const MOCK_CONTENT_VB = { x: 60, y: 80, w: 7200, h: 4820 };
const MOCK_INNER_XML = "<path d='M0 0 L10 10' />";
const MOCK_CACHED_DATA = {
  uri:            "",
  innerXml:       MOCK_INNER_XML,
  xml:            `<svg><g>${MOCK_INNER_XML}</g></svg>`,
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

// ─── Component ────────────────────────────────────────────────────────────────

import { WarehouseMapView } from "@/components/WarehouseMapView";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOOP = jest.fn();
const BASE_PROPS = {
  zones:        [],
  zonesLoading: false,
  zonesError:   false,
  onZonesRetry: NOOP,
  onZoneTap:    NOOP,
};

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

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
  nodes[0]!.props.onLayout({
    nativeEvent: { layout: { width, height, x: 0, y: 0 } },
  });
}

/**
 * Locate the web floor-plan <g> — the only host <g> that carries
 * dangerouslySetInnerHTML (the zone-overlay <g> elements do not).
 */
function findFloorPlanG(renderer: TestRenderer.ReactTestRenderer) {
  const matches = renderer.root.findAll(
    (n) =>
      n.type === "g" &&
      n.props != null &&
      n.props.dangerouslySetInnerHTML != null,
    { deep: true },
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one floor-plan <g>, found ${matches.length}`,
    );
  }
  // Length checked to be exactly 1 above.
  return matches[0]!;
}

async function mountWeb(scheme: "dark" | "light") {
  const rn = require("react-native");
  rn.Platform.OS = "web";
  rn.useColorScheme = () => scheme;

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<WarehouseMapView {...BASE_PROPS} />);
  });
  await flushPromises();
  await act(async () => {
    fireOnLayout(renderer, 390, 761);
  });
  return renderer;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

const originalPlatformOS = require("react-native").Platform.OS;
const originalUseColorScheme = require("react-native").useColorScheme;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  jest.clearAllMocks();

  const fpc = require("@/utils/floorPlanCache");
  fpc.getCachedData.mockReturnValue(MOCK_CACHED_DATA);
  fpc.hasCachedData.mockReturnValue(true);
  fpc.getCachedHash.mockReturnValue("abc123");
});

afterEach(() => {
  const rn = require("react-native");
  rn.Platform.OS = originalPlatformOS;
  rn.useColorScheme = originalUseColorScheme;
  jest.useRealTimers();
});

// =============================================================================
// Web floor-plan invert filter is gated on dark mode
// =============================================================================

describe("web floor-plan filter — invert only in dark mode", () => {
  it("dark mode: floor-plan <g> has filter 'invert(1) brightness(0.88)'", async () => {
    const renderer = await mountWeb("dark");
    const g = findFloorPlanG(renderer);
    expect(g.props.style.filter).toBe("invert(1) brightness(0.88)");
  });

  it("light mode: floor-plan <g> has filter 'none' (no invert)", async () => {
    const renderer = await mountWeb("light");
    const g = findFloorPlanG(renderer);
    expect(g.props.style.filter).toBe("none");
  });

  it("light mode: the invert filter must NOT be applied", async () => {
    const renderer = await mountWeb("light");
    const g = findFloorPlanG(renderer);
    // Guards against a future edit reintroducing the unconditional filter.
    expect(g.props.style.filter).not.toContain("invert");
  });

  it("dark mode: sanitized innerXml is embedded in the floor-plan <g>", async () => {
    const renderer = await mountWeb("dark");
    const g = findFloorPlanG(renderer);
    expect(g.props.dangerouslySetInnerHTML.__html).toBe(MOCK_INNER_XML);
  });
});
