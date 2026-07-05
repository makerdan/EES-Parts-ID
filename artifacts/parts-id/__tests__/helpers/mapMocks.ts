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
      background:        "#fff",
      foreground:        "#000",
      card:              "#fff",
      border:            "#ccc",
      primary:           "#3b82f6",
      primaryForeground: "#fff",
      muted:             "#f1f5f9",
      mutedForeground:   "#64748b",
      destructive:       "#ef4444",
      success:           "#22c55e",
      warning:           "#f59e0b",
      accent:            "#f1f5f9",
      accentForeground:  "#000",
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
 * @/utils/mapViewport — correct constants matching mapViewport.ts production values.
 *
 * Earlier tests used stale constants (SVG_VIEWBOX_W: 3592.55, MIN_SCALE: 0.5) that
 * no longer matched the source.  This canonical factory uses the real values.
 */
export function createMapViewportMock(): object {
  return {
    SVG_VIEWBOX_W:       7329.6001,
    SVG_VIEWBOX_H:       4997.2798,
    SVG_ASPECT:          7329.6001 / 4997.2798,
    MIN_SCALE:           0.8,
    MAX_SCALE:           50,
    FIT_PADDING:         16,
    ZOOM_STOPS:          [{ scale: 1.5 }, { scale: 4 }, { scale: 10 }, { scale: 22 }, { scale: 45 }],
    panBounds:           jest.fn().mockReturnValue({ maxX: 0, maxY: 0 }),
    clampScale:          jest.fn().mockImplementation((s: number) => Math.max(0.8, Math.min(50, s))),
    parseContentViewBox: jest.fn().mockReturnValue(null),
    fitContentViewport:  jest.fn().mockReturnValue({ scale: 1, tx: 0, ty: 0 }),
    computeFitTarget:    jest.fn().mockReturnValue({ scale: 1.5, tx: 0, ty: 0 }),
    makeTileViewBox:     jest.fn().mockReturnValue("0 0 100 100"),
    computeFocusPan:     jest.fn().mockReturnValue({ tx: 0, ty: 0 }),
    tileGridSize:        jest.fn().mockReturnValue(1),
    zoomStopForScale:    jest.fn().mockReturnValue(0),
    visibleTileRange:    jest.fn().mockReturnValue({ c0: 0, c1: 0, r0: 0, r1: 0 }),
  };
}
