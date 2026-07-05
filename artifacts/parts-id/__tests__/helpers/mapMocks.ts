/**
 * Shared Jest mock factories for native modules used across Map/Zone tests.
 *
 * Usage in a test file (jest.mock factories are hoisted, so reference via require()):
 *
 *   jest.mock("react-native-reanimated",      () => require("./helpers/mapMocks").createReanimatedMock());
 *   jest.mock("react-native-gesture-handler", () => require("./helpers/mapMocks").createGestureHandlerMock());
 *   jest.mock("react-native-svg",             () => require("./helpers/mapMocks").createSvgMock());
 *   jest.mock("expo-asset",                   () => require("./helpers/mapMocks").createExpoAssetMock());
 *   jest.mock("@expo/vector-icons",           () => require("./helpers/mapMocks").createVectorIconsMock());
 *   jest.mock("@/hooks/useColors",            () => require("./helpers/mapMocks").createUseColorsMock());
 *   jest.mock("@/utils/floorPlanCache",       () => require("./helpers/mapMocks").createFloorPlanCacheMock());
 *   jest.mock("@/utils/mapViewport",          () => require("./helpers/mapMocks").createMapViewportMock());
 */

/** react-native-reanimated — full version with Easing and both default and named exports. */
export function createReanimatedMock(): object {
  const React = require("react");
  const passThrough = (v: unknown) => v;
  const AnimatedView = ({ children, ...rest }: Record<string, unknown>) =>
    React.createElement("rn-reanimated-view", rest, children);
  const createAnimatedComponent = (Component: unknown) => Component;
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      ScrollView: ({ children }: { children: unknown }) =>
        React.createElement("rn-animated-scroll", {}, children),
      createAnimatedComponent,
    },
    Animated: { View: AnimatedView, createAnimatedComponent },
    useSharedValue:      (initial: unknown) => ({ value: initial }),
    useAnimatedProps:    (_fn: () => unknown) => ({}),
    useAnimatedStyle:    (_fn: () => unknown) => ({}),
    useAnimatedReaction: () => {},
    runOnJS:             (fn: (...args: unknown[]) => unknown) => fn,
    cancelAnimation:     () => {},
    withSpring:          passThrough,
    withTiming:          passThrough,
    withRepeat:          passThrough,
    Easing: { bezier: () => 0, inOut: passThrough, ease: 0, linear: 0 },
    createAnimatedComponent,
  };
}

/** react-native-gesture-handler — full chainable version (covers all gesture methods). */
export function createGestureHandlerMock(): object {
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
      Pan:          makeChainable,
      Pinch:        makeChainable,
      Tap:          makeChainable,
      LongPress:    makeChainable,
      Simultaneous: (..._args: unknown[]) => makeChainable(),
      Exclusive:    (..._args: unknown[]) => makeChainable(),
      Race:         (..._args: unknown[]) => makeChainable(),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
}

/** react-native-svg — full tag-forwarding version. */
export function createSvgMock(): object {
  const React = require("react");
  const noop = () => null;
  const make = (tag: string) =>
    ({ children, ...rest }: Record<string, unknown>) =>
      React.createElement(tag, rest, children);
  return {
    default:  make("svg"),
    Svg:      make("svg"),
    Rect:     make("svg-rect"),
    G:        make("g"),
    Text:     make("svg-text"),
    SvgUri:   noop,
    SvgXml:   noop,
    Path:     noop,
    Ellipse:  noop,
    Circle:   noop,
    Defs:     make("defs"),
    ClipPath: make("clip-path"),
    Use:      noop,
    Symbol:   noop,
  };
}

/** expo-asset — standard stub for MapScreen-level tests. */
export function createExpoAssetMock(): object {
  return {
    Asset: {
      fromModule: () => ({ downloadAsync: async () => {}, localUri: "" }),
      loadAsync:  async () => [{ hash: "test", localUri: "", uri: "" }],
    },
  };
}

/** @expo/vector-icons */
export function createVectorIconsMock(): object {
  return { Feather: () => null, MaterialCommunityIcons: () => null };
}

/** @/hooks/useColors */
export function createUseColorsMock(): object {
  return {
    useColors: () => ({
      text:                  "#1a1a1a",
      tint:                  "#f59e0b",
      background:            "#f5f5f0",
      foreground:            "#1a1a1a",
      card:                  "#ffffff",
      cardForeground:        "#1a1a1a",
      primary:               "#f59e0b",
      primaryForeground:     "#ffffff",
      secondary:             "#e5e7eb",
      secondaryForeground:   "#374151",
      muted:                 "#e5e7eb",
      mutedForeground:       "#6b7280",
      accent:                "#fef3c7",
      accentForeground:      "#92400e",
      destructive:           "#ef4444",
      destructiveForeground: "#ffffff",
      success:               "#10b981",
      successForeground:     "#ffffff",
      warning:               "#f59e0b",
      warningForeground:     "#ffffff",
      border:                "#d1d5db",
      input:                 "#d1d5db",
      steel:                 "#374151",
      steelLight:            "#6b7280",
      amber:                 "#f59e0b",
      amberDark:             "#d97706",
      surface:               "#f9fafb",
      overlay:               "rgba(0,0,0,0.5)",
      radius:                8,
    }),
  };
}

/** @/utils/floorPlanCache */
export function createFloorPlanCacheMock(): object {
  return {
    getCachedData:        jest.fn().mockReturnValue(null),
    getCachedHash:        jest.fn().mockReturnValue(null),
    getIfValid:           jest.fn().mockReturnValue(null),
    hasCachedData:        jest.fn().mockReturnValue(false),
    initPersistRead:      jest.fn().mockReturnValue(Promise.resolve()),
    resetForServerUpdate: jest.fn(),
    setCached:            jest.fn(),
    setFallbackEmpty:     jest.fn(),
  };
}

/**
 * @/utils/mapViewport — mock factory that derives numeric constants from the
 * real source module via jest.requireActual so they can never drift.
 *
 * Earlier tests hardcoded stale values (SVG_VIEWBOX_W: 3592.55, MIN_SCALE: 0.5)
 * that no longer matched the source.  By importing the actual constants here,
 * any future change to mapViewport.ts is reflected automatically and a drift
 * causes a test failure rather than a silent wrong-value pass.
 */
export function createMapViewportMock(): object {
  const actual = jest.requireActual<{
    SVG_VIEWBOX_W: number;
    SVG_VIEWBOX_H: number;
    SVG_ASPECT:    number;
    MIN_SCALE:     number;
    MAX_SCALE:     number;
    FIT_PADDING:   number;
    ZOOM_STOPS:    ReadonlyArray<{ z: number; scale: number; label: string }>;
  }>("@/utils/mapViewport");
  return {
    SVG_VIEWBOX_W:       actual.SVG_VIEWBOX_W,
    SVG_VIEWBOX_H:       actual.SVG_VIEWBOX_H,
    SVG_ASPECT:          actual.SVG_ASPECT,
    MIN_SCALE:           actual.MIN_SCALE,
    MAX_SCALE:           actual.MAX_SCALE,
    FIT_PADDING:         actual.FIT_PADDING,
    ZOOM_STOPS:          actual.ZOOM_STOPS,
    panBounds:           jest.fn().mockReturnValue({ maxX: 0, maxY: 0 }),
    clampScale:          jest.fn().mockImplementation((s: number) => Math.max(actual.MIN_SCALE, Math.min(actual.MAX_SCALE, s))),
    parseContentViewBox: jest.fn().mockReturnValue(null),
    fitContentViewport:  jest.fn().mockReturnValue({ scale: 1, tx: 0, ty: 0 }),
    computeFitTarget:    jest.fn().mockReturnValue({ scale: actual.ZOOM_STOPS[0].scale, tx: 0, ty: 0 }),
    makeTileViewBox:     jest.fn().mockReturnValue("0 0 100 100"),
    computeFocusPan:     jest.fn().mockReturnValue({ tx: 0, ty: 0 }),
    tileGridSize:        jest.fn().mockReturnValue(1),
    zoomStopForScale:    jest.fn().mockReturnValue(0),
    visibleTileRange:    jest.fn().mockReturnValue({ c0: 0, c1: 0, r0: 0, r1: 0 }),
  };
}
