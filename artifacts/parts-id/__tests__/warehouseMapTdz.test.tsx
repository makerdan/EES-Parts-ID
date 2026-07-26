/**
 * Regression smoke-test: TDZ-style forward-reference crash in WarehouseMapView
 *
 * Background
 * ──────────
 * The Map tab crashed on web because `pinchGesture` captured `_cancelPrefetch`
 * and `snapToNearestZoomStop` via `runOnJS()` before those `const` bindings
 * were initialised (Temporal Dead Zone).  TypeScript and ESLint are both blind
 * to declaration-order TDZ bugs; only a render attempt surfaces them.
 *
 * What this test does
 * ───────────────────
 * Mounts WarehouseMapView with Platform.OS = "web" and minimal props, then
 * asserts the component tree was created without throwing a ReferenceError (or
 * any other Error).  If the declaration order regresses, the `Gesture.Pinch()`
 * builder call that references the still-uninitialised consts will throw during
 * the first render and the test will fail.
 *
 * Mock strategy
 * ─────────────
 * Identical to warehouseMapCacheCleanup.test.tsx: all heavy native modules are
 * stubbed inline so @testing-library/react-native can import and render the component.
 * No `onLayout` is fired so `containerW` stays 0 and the component hits its
 * early-return guard — only the gesture-setup and hook-initialisation code runs,
 * which is exactly the code path where TDZ violations occur.
 */

// React 19 requires IS_REACT_ACT_ENVIRONMENT = true for act() to flush
// synchronous state updates and suppress spurious act() warnings.
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";

// ─── react-native-reanimated ──────────────────────────────────────────────────
jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());

// ─── react-native-gesture-handler ────────────────────────────────────────────
jest.mock("react-native-gesture-handler", () => require("./helpers/mapMocks").createGestureHandlerMock());

// ─── react-native-svg ────────────────────────────────────────────────────────
jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── @/utils/apiBase ─────────────────────────────────────────────────────────
// Return an empty API_BASE so the server-hash polling setInterval in
// WarehouseMapView (guarded by `if (!API_BASE) return`) is never registered.
// Without this mock the guard throws in Jest (__DEV__=false, no env var set)
// before any test can run.
jest.mock("@/utils/apiBase", () => ({ API_BASE: "" }));

// ─── expo-asset ──────────────────────────────────────────────────────────────
jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());

// ─── @expo/vector-icons ───────────────────────────────────────────────────────
jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

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

// ─── @/utils/floorPlan ────────────────────────────────────────────────────────
jest.mock("@/utils/floorPlan", () => ({
  warmupTiles: jest.fn(() => Promise.resolve()),
  tileApiUrl: jest.fn((z: number, x: number, y: number) =>
    `/floor-plan/tiles/${z}/${x}/${y}.png`),
}));

// ─── @/utils/tilePyramidCache ─────────────────────────────────────────────────
jest.mock("@/utils/tilePyramidCache", () => ({
  cleanStaleCacheDirs: jest.fn(() => Promise.resolve()),
  fetchTile: jest.fn(() => Promise.resolve("")),
  prefetchZoomLevel: jest.fn(() => Promise.resolve()),
}));

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────
jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

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

// ─── Per-test renderer registry for cleanup ───────────────────────────────────
// Results that are not explicitly unmounted keep the React scheduler alive and
// cause Jest to force-exit.  Collect every created result so afterEach can
// unmount them all, regardless of whether the individual test stored a reference.
const activeResults: RenderResult[] = [];

beforeEach(() => {
  // Fake timers prevent the 3 s setEmptyDismissed setTimeout from firing as a
  // real macrotask after each test ends.  nextTick/setImmediate are kept real so
  // act(async) and Promise chains resolve normally.
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });

  jest.clearAllMocks();
  // Force web mode — this is the platform where the TDZ crash occurred.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require("react-native").Platform as { OS: string }).OS = "web";
});

afterEach(async () => {
  // Unmount all results created during the test so the React concurrent
  // scheduler does not keep the worker alive and trigger a force-exit.
  while (activeResults.length) {
    const r = activeResults.pop()!;
    await r.unmount();
  }
  // Restore real timers and native platform so other test files are not affected.
  jest.useRealTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require("react-native").Platform as { OS: string }).OS = "ios";
});

// ─────────────────────────────────────────────────────────────────────────────
// TDZ smoke-test: render on web must not throw a ReferenceError
// ─────────────────────────────────────────────────────────────────────────────
//
// The regression: pinchGesture captured _cancelPrefetch and snapToNearestZoomStop
// via runOnJS() before those consts were declared. The React Compiler reads
// callback bindings during render to build memoisation, so a declaration that
// appears after its consumer in the function body throws ReferenceError on the
// very first render — silently on native (where the worklet plugin hoists the
// values into a separate closure), but fatally on web.

describe("WarehouseMapView — web render smoke-test (TDZ regression guard)", () => {
  it("renders on web without throwing a ReferenceError", async () => {
    await expect(
      (async () => { activeResults.push(await render(<WarehouseMapView {...BASE_PROPS} />)); })()
    ).resolves.not.toThrow();
  });

  it("produces a non-null render result on web", async () => {
    const result: RenderResult = await render(<WarehouseMapView {...BASE_PROPS} />);
    activeResults.push(result);

    expect(result).not.toBeNull();
    // The component renders at least one element — confirms the tree was
    // actually created rather than short-circuiting to null via an error boundary.
    expect(result.toJSON()).not.toBeNull();
  });

  it("renders consistently across two successive mounts on web", async () => {
    // A TDZ crash would throw on both mounts — two independent mount attempts
    // confirm the failure is not a one-off initialisation artifact.
    activeResults.push(await render(<WarehouseMapView {...BASE_PROPS} />));
    activeResults.push(await render(<WarehouseMapView {...BASE_PROPS} />));

    // If we reach here, neither mount threw — the test passes.
    expect(true).toBe(true);
  });
});
