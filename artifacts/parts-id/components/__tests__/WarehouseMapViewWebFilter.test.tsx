/**
 * Regression tests: web floor-plan colour-invert filter is dark-mode-only.
 *
 * Background
 * ──────────
 * An `invert(1) brightness(0.88)` CSS filter was being applied to the web
 * floor-plan surface whenever the OS/browser reported dark mode — even when the
 * user's in-app theme setting was "light".  The root cause was WarehouseMapView
 * calling `useColorScheme()` (raw OS preference) instead of `useIsDark()` (which
 * respects the user's explicit in-app setting).
 *
 * Fix
 * ───
 * WarehouseMapView now derives `isDark` exclusively through `useIsDark()` from
 * @/hooks/useColors.  The filter is gated:
 *
 *     filter: isDark ? "invert(1) brightness(0.88)" : "none"
 *
 * What these tests verify
 * ───────────────────────
 * 1. When `useIsDark()` returns false  → filter is "none"  (no invert in light mode).
 * 2. When `useIsDark()` returns true   → filter is "invert(1) brightness(0.88)".
 * 3. Light mode: the string "invert" never appears anywhere in the filter value.
 * 4. The injected floor-plan SVG body is always present (both modes).
 *
 * Mock strategy
 * ─────────────
 * • @/hooks/useColors is mocked at the module level.  `useIsDark` is a
 *   jest.fn() whose return value is set per-test in `mountWeb(scheme)`.
 *   This is intentionally separate from react-native's `useColorScheme` —
 *   the component must not consult the OS scheme directly, only through the
 *   hook.  Overriding `useColorScheme` in these tests would therefore NOT
 *   catch a regression where someone swaps back to the raw call.
 * • Platform.OS is forced to "web" so the web unified SVG branch renders
 *   instead of the native tile path.
 * • @/utils/floorPlanCache.getCachedData returns non-empty xml so `svgXml`
 *   state is truthy on mount — the unified web SVG only renders when its
 *   canonical scene is valid.
 */

// React 19 requires IS_REACT_ACT_ENVIRONMENT = true for act() to flush
// synchronous state updates triggered by onLayout.
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";

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

// ─── @/hooks/useColors ───────────────────────────────────────────────────────
// Mocked here so tests control isDark through useIsDark() — the same path the
// component uses — rather than monkey-patching react-native's useColorScheme.
// If a future edit reverts to raw useColorScheme(), these tests will still pass
// (because the OS scheme is whatever Jest's RN mock returns), hiding the
// regression.  By mocking at the hook boundary we guarantee the component
// actually calls useIsDark() for its isDark value.

const LIGHT_COLORS = {
  text: "#1a1a1a",
  tint: "#f59e0b",
  background: "#f5f5f0",
  foreground: "#1a1a1a",
  card: "#ffffff",
  cardForeground: "#1a1a1a",
  primary: "#f59e0b",
  primaryForeground: "#ffffff",
  secondary: "#e5e7eb",
  secondaryForeground: "#374151",
  muted: "#e5e7eb",
  mutedForeground: "#6b7280",
  accent: "#fef3c7",
  accentForeground: "#92400e",
  destructive: "#ef4444",
  destructiveForeground: "#ffffff",
  success: "#10b981",
  successForeground: "#ffffff",
  warning: "#f59e0b",
  warningForeground: "#ffffff",
  border: "#d1d5db",
  input: "#d1d5db",
  steel: "#374151",
  steelLight: "#6b7280",
  amber: "#f59e0b",
  amberDark: "#d97706",
  surface: "#f9fafb",
  overlay: "rgba(0,0,0,0.5)",
  radius: 8,
};

jest.mock("@/hooks/useColors", () => ({
  useColors: jest.fn(() => LIGHT_COLORS),
  useIsDark: jest.fn(() => false),
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
// xml is non-empty so the web floor-plan SVG renders on mount.

const MOCK_CONTENT_VB = { x: 60, y: 80, w: 7200, h: 4820 };
const MOCK_INNER_XML = "<path d='M0 0 L10 10' />";
const MOCK_CACHED_DATA = {
  uri:            "",
  innerXml:       MOCK_INNER_XML,
  xml:            `<svg viewBox="60 80 7200 4820"><g>${MOCK_INNER_XML}</g></svg>`,
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
  result: Awaited<ReturnType<typeof render>>,
  width: number,
  height: number,
) {
  const nodes = result.root!.queryAll(
    (n) => typeof n.props.onLayout === "function",
    { includeSelf: true },
  );
  if (nodes.length === 0) throw new Error("No onLayout node found");
  nodes[0]!.props.onLayout({
    nativeEvent: { layout: { width, height, x: 0, y: 0 } },
  });
}

/**
 * Locate the web floor-plan <g> — the only host node that carries
 * dangerouslySetInnerHTML (the injected floor-plan SVG body).
 */
function findFloorPlanGroup(result: Awaited<ReturnType<typeof render>>) {
  const matches = result.root!.queryAll(
    (n) =>
      n.type === "g" &&
      n.props != null &&
      n.props.dangerouslySetInnerHTML != null,
    { includeSelf: true },
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one floor-plan <g>, found ${matches.length}`,
    );
  }
  // Length checked to be exactly 1 above.
  return matches[0]!;
}

/**
 * Mount WarehouseMapView in web mode with useIsDark() controlled via the mock.
 *
 * NOTE: we set useIsDark on the @/hooks/useColors mock, NOT on react-native's
 * useColorScheme.  If a future change reverts the component to reading
 * useColorScheme() directly, these tests will no longer correctly exercise the
 * dark-mode path (the OS scheme will be whatever the RN mock returns), and the
 * underlying regression will go undetected.  The correct fix is always to
 * restore useIsDark() in the component, not to patch useColorScheme in tests.
 */
async function mountWeb(scheme: "dark" | "light"): Promise<RenderResult> {
  const hooks = require("@/hooks/useColors") as {
    useColors: jest.Mock;
    useIsDark: jest.Mock;
  };
  hooks.useIsDark.mockReturnValue(scheme === "dark");

  const rn = require("react-native");
  rn.Platform.OS = "web";

  const result = await render(<WarehouseMapView {...BASE_PROPS} />);
  await flushPromises();
  await act(async () => {
    fireOnLayout(result, 390, 761);
  });
  return result;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

const originalPlatformOS = require("react-native").Platform.OS;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  jest.clearAllMocks();

  // Restore hook mocks after clearAllMocks resets their implementations.
  const hooks = require("@/hooks/useColors") as {
    useColors: jest.Mock;
    useIsDark: jest.Mock;
  };
  hooks.useColors.mockReturnValue(LIGHT_COLORS);
  hooks.useIsDark.mockReturnValue(false); // default: light

  const fpc = require("@/utils/floorPlanCache");
  fpc.getCachedData.mockReturnValue(MOCK_CACHED_DATA);
  fpc.hasCachedData.mockReturnValue(true);
  fpc.getCachedHash.mockReturnValue("abc123");
});

afterEach(() => {
  const rn = require("react-native");
  rn.Platform.OS = originalPlatformOS;
  jest.useRealTimers();
});

// =============================================================================
// Web floor-plan invert filter is gated on useIsDark()
// =============================================================================

describe("web floor-plan filter — invert only when useIsDark() returns true", () => {
  it("dark mode (useIsDark=true): floor-plan <g> has filter 'invert(1) brightness(0.88)'", async () => {
    const result = await mountWeb("dark");
    const group = findFloorPlanGroup(result);
    expect(group.props.style.filter).toBe("invert(1) brightness(0.88)");
  });

  it("light mode (useIsDark=false): floor-plan <g> has filter 'none' (no invert)", async () => {
    const result = await mountWeb("light");
    const group = findFloorPlanGroup(result);
    expect(group.props.style.filter).toBe("none");
  });

  it("light mode: the string 'invert' must NOT appear in the filter value", async () => {
    const result = await mountWeb("light");
    const group = findFloorPlanGroup(result);
    // Guards against both partial invert and any future filter reintroduction.
    expect(group.props.style.filter).not.toContain("invert");
  });

  it("dark mode: the SVG floor-plan body is embedded in the unified scene", async () => {
    const result = await mountWeb("dark");
    const group = findFloorPlanGroup(result);
    const html = group.props.dangerouslySetInnerHTML.__html as string;
    expect(html.startsWith("<g>")).toBe(true);
    expect(html).toContain(MOCK_INNER_XML);
  });

  it("light mode: the SVG floor-plan body is also present (floor plan renders in both modes)", async () => {
    const result = await mountWeb("light");
    const group = findFloorPlanGroup(result);
    const html = group.props.dangerouslySetInnerHTML.__html as string;
    expect(html.startsWith("<g>")).toBe(true);
    expect(html).toContain(MOCK_INNER_XML);
  });

});
