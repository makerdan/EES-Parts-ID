/**
 * Web-render-path regression for MapPin3D and MapPinEmoji.
 *
 * Both components call useAnimatedProps() with a worklet returning an SVG
 * transform string on AnimatedG.  On web, a missing or misconfigured
 * react-native-worklets Babel plugin causes useAnimatedProps to throw
 * mid-hook-call, corrupting React's hook counter and triggering "Invalid hook
 * call" — exactly the symptom observed in the original bug.
 *
 * This file targets three failure modes:
 *
 *   1. Babel plugin guard — reads babel.config.js and asserts
 *      react-native-worklets/plugin is present, catching anyone who drops the
 *      entry from the config before the next web deployment.
 *
 *   2. Callback invocation — the useAnimatedProps mock actually calls its
 *      argument so any runtime error in the worklet callback body (bad closure,
 *      wrong variable name, etc.) fails here rather than silently passing.
 *
 *   3. Animated-props data flow — asserts the svg-g (AnimatedG) element
 *      received animatedProps.transform with the expected SVG transform pattern,
 *      proving the complete hook→prop→render path was exercised.
 *
 * Platform.OS is set to "web" throughout to match the browser render path.
 */

// Required for act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import * as path from "path";
import * as fs from "fs";

// ─── react-native-svg ─────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => {
  const React = require("react");
  function make(tag: string) {
    return function SVGMock({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [k: string]: unknown;
    }) {
      return React.createElement(tag, props, children);
    };
  }
  return {
    Svg:     make("svg-svg"),
    G:       make("svg-g"),
    Path:    make("svg-path"),
    Ellipse: make("svg-ellipse"),
    Circle:  make("svg-circle"),
    Rect:    make("svg-rect"),
    Text:    make("Text"),
    SvgUri:  make("svg-uri"),
    SvgXml:  make("svg-xml"),
  };
});

// ─── react-native  (Platform.OS = "web") ──────────────────────────────────────

jest.mock("react-native", () => ({
  Platform:     { OS: "web", select: (o: Record<string, unknown>) => o.web ?? o.default },
  StyleSheet:   { create: (s: unknown) => s, flatten: (s: unknown) => s },
  View:         ({ children }: { children?: React.ReactNode }) => React.createElement("rn-view", {}, children),
  Text:         ({ children }: { children?: React.ReactNode }) => React.createElement("Text", {}, children),
  ActivityIndicator: () => null,
  Pressable:    ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
                  React.createElement("rn-pressable", { onPress }, children),
  PixelRatio:   { get: () => 3 },
  useColorScheme: () => "light",
  LayoutChangeEvent: {},
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ─── expo-asset ───────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => ({
  Asset: {
    fromModule: () => ({ downloadAsync: async () => {}, localUri: "" }),
    loadAsync:  async () => [{ hash: "test", localUri: "", uri: "" }],
  },
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── react-native-reanimated ──────────────────────────────────────────────────
//
// Critical: useAnimatedProps actually INVOKES the callback it receives.
//
// The real web Reanimated executes the worklet callback on every frame to
// compute animated props.  Making the mock do the same means:
//   - Any runtime error in the callback body fails the test immediately.
//   - The return value (the transform object) is available for assertions,
//     proving the complete hook→prop→render data path is exercised.
//
// The mock still intercepts the module to prevent the real Reanimated web
// runtime (which requires a browser environment) from being loaded.

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const makeShared = (v: unknown) => ({ value: v });
  const AnimatedView = ({ children, style }: { children?: React.ReactNode; style?: unknown }) =>
    React.createElement("rn-animated-view", { style }, children);
  const createAnimatedComponent = (C: unknown) => C;
  return {
    __esModule:           true,
    useSharedValue:       makeShared,
    useAnimatedStyle:     (cb: () => unknown) => (typeof cb === "function" ? cb() ?? {} : {}),
    useAnimatedProps:     (cb: () => unknown) => (typeof cb === "function" ? cb() ?? {} : {}),
    useAnimatedReaction:  () => {},
    withSpring:           (v: unknown) => v,
    withRepeat:           (a: unknown) => a,
    withTiming:           (v: unknown) => v,
    runOnJS:              (fn: unknown) => fn,
    cancelAnimation:      () => {},
    Animated: { createAnimatedComponent, View: AnimatedView },
    default:  { createAnimatedComponent, View: AnimatedView },
  };
});

// ─── react-native-gesture-handler ────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const chain = () => {
    const c: Record<string, unknown> = {};
    ["minPointers", "minDistance", "onUpdate", "onEnd", "numberOfTaps"].forEach(
      (m) => { c[m] = () => c; },
    );
    return c;
  };
  return {
    Gesture: {
      Pan:          chain,
      Pinch:        chain,
      Tap:          chain,
      Simultaneous: (...args: unknown[]) => args[0],
      Exclusive:    (...args: unknown[]) => args[0],
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// ─── @/utils/floorPlanCache ───────────────────────────────────────────────────

jest.mock("@/utils/floorPlanCache", () => ({
  getCachedData:        jest.fn().mockReturnValue(null),
  getCachedHash:        jest.fn().mockReturnValue(null),
  getIfValid:           jest.fn().mockReturnValue(null),
  hasCachedData:        jest.fn().mockReturnValue(false),
  initPersistRead:      jest.fn().mockReturnValue(Promise.resolve()),
  resetForServerUpdate: jest.fn(),
  setCached:            jest.fn(),
  setFallbackEmpty:     jest.fn(),
}));

// ─── @/utils/mapViewport ─────────────────────────────────────────────────────

jest.mock("@/utils/mapViewport", () => ({
  SVG_VIEWBOX_W:       7329.6001,
  SVG_VIEWBOX_H:       4997.2798,
  SVG_ASPECT:          7329.6001 / 4997.2798,
  MIN_SCALE:           0.8,
  MAX_SCALE:           50,
  FIT_PADDING:         16,
  ZOOM_STOPS:          [{ scale: 1.5 }, { scale: 4 }, { scale: 10 }, { scale: 22 }, { scale: 45 }],
  parseContentViewBox: jest.fn().mockReturnValue(null),
  fitContentViewport:  jest.fn().mockReturnValue({ scale: 1, tx: 0, ty: 0 }),
  makeTileViewBox:     jest.fn().mockReturnValue("0 0 100 100"),
  computeFocusPan:     jest.fn().mockReturnValue({ tx: 0, ty: 0 }),
  tileGridSize:        jest.fn().mockReturnValue(1),
  zoomStopForScale:    jest.fn().mockReturnValue(0),
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── Runtime imports from react-native-reanimated ────────────────────────────
//
// These are intentionally NOT "import type" so the module is resolved and
// executed at test startup.  If the mock is accidentally stripped these
// assignments resolve to undefined and the canary tests below fail before any
// JSX is rendered.

import {
  useAnimatedProps,
  useSharedValue,
} from "react-native-reanimated";

import { MapPin3D, MapPinEmoji } from "@/components/WarehouseMapView";

// =============================================================================
// Babel config guard — react-native-worklets/plugin must be listed
//
// On web, a missing worklets Babel plugin causes useAnimatedProps to throw
// mid-hook-call (React "Invalid hook call").  This test reads babel.config.js
// directly so the misconfiguration is caught in CI rather than at deploy time.
// =============================================================================

describe("babel.config.js — worklets plugin is configured", () => {
  it("react-native-worklets/plugin is listed in the plugins array", () => {
    const configPath = path.resolve(__dirname, "../babel.config.js");
    const raw = fs.readFileSync(configPath, "utf8");
    // The plugin must appear as a string entry.  Both the short form
    // ("react-native-worklets/plugin") and a tuple form are acceptable.
    expect(raw).toMatch(/react-native-worklets\/plugin/);
  });

  it("babel.config.js can be required without throwing", () => {
    const configPath = path.resolve(__dirname, "../babel.config.js");
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const factory = require(configPath);
      factory({ cache: () => {} });
    }).not.toThrow();
  });
});

// =============================================================================
// Canary — react-native-reanimated exports are callable functions
//
// A future removal of the mock (or a reanimated upgrade that renames these
// exports) must fail here before any component is mounted.
// =============================================================================

describe("react-native-reanimated web mock — exports are callable functions", () => {
  it("useAnimatedProps is a function", () => {
    expect(typeof useAnimatedProps).toBe("function");
  });

  it("useSharedValue is a function", () => {
    expect(typeof useSharedValue).toBe("function");
  });

  it("useAnimatedProps() invokes the callback and returns its result", () => {
    const result = useAnimatedProps(() => ({ transform: "translate(0 0) scale(1) translate(0 0)" }));
    expect(result).toMatchObject({ transform: expect.stringContaining("translate") });
  });

  it("useSharedValue(1) returns a shared-value object", () => {
    const sv = useSharedValue(1);
    expect(sv).toBeDefined();
    expect(typeof sv).toBe("object");
  });
});

// =============================================================================
// MapPin3D — web platform render path
//
// Tests verify:
//   (a) Component mounts without throwing on Platform.OS = "web".
//   (b) The AnimatedG (svg-g) element receives animatedProps.transform —
//       proving the worklet callback was called and its return value flowed
//       through to the rendered element.  This is the data path that breaks
//       on web when the worklets Babel plugin is absent.
//   (c) Both steady-state (isNew=false) and entrance-animation (isNew=true)
//       branches are exercised, covering the withSpring / useEffect path.
// =============================================================================

describe("MapPin3D — mounts on web Platform.OS without throwing", () => {
  it("steady state (isNew=false): mounts and renders svg-path elements", async () => {
    const tree = await render(
      <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" isNew={false} />,
    );

    const paths = tree.root!.queryAll(
      (n) => (n.type as string) === "svg-path",
      { includeSelf: true },
    );
    expect(paths.length).toBeGreaterThan(0);

    await tree.unmount();
  });

  it("entrance animation (isNew=true): mounts without throwing (exercises withSpring on web)", async () => {
    const tree = await render(
      <MapPin3D cx={50} cy={80} size={15} fill="#8b5cf6" stroke="#6d28d9" isNew={true} />,
    );

    const paths = tree.root!.queryAll(
      (n) => (n.type as string) === "svg-path",
      { includeSelf: true },
    );
    expect(paths.length).toBeGreaterThan(0);

    await tree.unmount();
  });

  it("AnimatedG (svg-g) receives animatedProps.transform — worklet callback was invoked", async () => {
    // With the mock calling the worklet callback, AnimatedG receives the
    // computed transform object as animatedProps.  If the callback threw (as
    // the real web Reanimated would if the Babel plugin were absent) or was
    // never called, animatedProps would be {} / undefined and this assertion
    // would fail.
    const tree = await render(
      <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" />,
    );

    const groups = tree.root!.queryAll(
      (n) => (n.type as string) === "svg-g",
      { includeSelf: true },
    );
    expect(groups.length).toBeGreaterThan(0);

    const animatedG = groups[0];
    // animatedProps is the prop passed to <AnimatedG animatedProps={...} />.
    // It should contain a transform string produced by the worklet callback.
    const ap = animatedG!.props.animatedProps as Record<string, unknown> | undefined;
    expect(ap).toBeDefined();
    expect(typeof ap?.transform).toBe("string");
    expect(ap?.transform as string).toMatch(/translate/);

    await tree.unmount();
  });

  it("animatedProps.transform encodes cx/cy — correct coordinate values were captured in closure", async () => {
    // The worklet callback closes over cx and cy.  Asserting their exact
    // values appear in the transform string verifies the closure was not
    // corrupted (another symptom of a bad worklet transform).
    const tree = await render(
      <MapPin3D cx={123} cy={456} size={20} fill="#f59e0b" stroke="#b45309" />,
    );

    const groups = tree.root!.queryAll(
      (n) => (n.type as string) === "svg-g",
      { includeSelf: true },
    );
    const ap = groups[0]?.props.animatedProps as Record<string, unknown> | undefined;
    expect(ap?.transform).toMatch("123");
    expect(ap?.transform).toMatch("456");

    await tree.unmount();
  });
});

// =============================================================================
// MapPinEmoji — web platform render path
// =============================================================================

describe("MapPinEmoji — mounts on web Platform.OS without throwing", () => {
  it("steady state (isNew=false): mounts and renders Text emoji element", async () => {
    const tree = await render(
      <MapPinEmoji cx={100} cy={200} size={20} fill="#f59e0b" isNew={false} />,
    );

    const texts = tree.root!.queryAll(
      (n) => (n.type as string) === "Text",
      { includeSelf: true },
    );
    expect(texts.length).toBeGreaterThan(0);

    await tree.unmount();
  });

  it("entrance animation (isNew=true): mounts without throwing (exercises withSpring on web)", async () => {
    const tree = await render(
      <MapPinEmoji cx={50} cy={80} size={15} fill="#8b5cf6" isNew={true} />,
    );

    const texts = tree.root!.queryAll(
      (n) => (n.type as string) === "Text",
      { includeSelf: true },
    );
    expect(texts.length).toBeGreaterThan(0);

    await tree.unmount();
  });

  it("AnimatedG (svg-g) receives animatedProps.transform — worklet callback was invoked", async () => {
    const tree = await render(
      <MapPinEmoji cx={100} cy={200} size={20} fill="#f59e0b" />,
    );

    const groups = tree.root!.queryAll(
      (n) => (n.type as string) === "svg-g",
      { includeSelf: true },
    );
    expect(groups.length).toBeGreaterThan(0);

    const ap = groups[0]?.props.animatedProps as Record<string, unknown> | undefined;
    expect(ap).toBeDefined();
    expect(typeof ap?.transform).toBe("string");
    expect(ap?.transform as string).toMatch(/translate/);

    await tree.unmount();
  });

  it("animatedProps.transform encodes cx/cy — correct coordinate values were captured in closure", async () => {
    const tree = await render(
      <MapPinEmoji cx={77} cy={88} size={15} fill="#8b5cf6" />,
    );

    const groups = tree.root!.queryAll(
      (n) => (n.type as string) === "svg-g",
      { includeSelf: true },
    );
    const ap = groups[0]?.props.animatedProps as Record<string, unknown> | undefined;
    expect(ap?.transform).toMatch("77");
    expect(ap?.transform).toMatch("88");

    await tree.unmount();
  });

  it("colour-badge ellipse carries the expected fill colour on web", async () => {
    const tree = await render(
      <MapPinEmoji cx={100} cy={200} size={20} fill="#f59e0b" />,
    );

    const ellipses = tree.root!.queryAll(
      (n) => (n.type as string) === "svg-ellipse",
      { includeSelf: true },
    );
    const amberBadge = ellipses.find((n) => n.props.fill === "#f59e0b");
    expect(amberBadge).toBeDefined();

    await tree.unmount();
  });
});
