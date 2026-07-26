/**
 *
 * Verifies that MapPin3D, MapPinEmoji, and ZoneOverlayItem each call
 * cancelAnimation on their Reanimated shared values when:
 *   - the component unmounts (any scenario)
 *   - isNew flips false after being true (for the pin-scale effect)
 *
 * A missed cancelAnimation leaves a UI-thread worklet running that can
 * crash when it tries to write to a detached shared value after unmount.
 *
 * Strategy
 * --------
 * cancelAnimation is exposed as jest.fn() from the Reanimated mock so
 * each call can be detected and inspected.  @testing-library/react-native
 * drives mount/unmount/update inside act() so useEffect cleanup runs synchronously.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";

// ─── react-native-svg ─────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── react-native ─────────────────────────────────────────────────────────────

jest.mock("react-native", () => ({
  Platform:          { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet:        { create: (s: unknown) => s, flatten: (s: unknown) => s },
  View:              ({ children }: { children?: React.ReactNode }) => React.createElement("rn-view", {}, children),
  Text:              ({ children }: { children?: React.ReactNode }) => React.createElement("Text", {}, children),
  ActivityIndicator: () => null,
  Pressable:         ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
                       React.createElement("rn-pressable", { onPress }, children),
  PixelRatio:        { get: () => 3 },
  useColorScheme:    () => "light",
  LayoutChangeEvent: {},
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

// ─── expo-asset ─────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());
// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── react-native-reanimated ──────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMockWithCancelSpy());

// ─── react-native-gesture-handler ────────────────────────────────────────────

jest.mock("react-native-gesture-handler", () => require("./helpers/mapMocks").createGestureHandlerMock());

// ─── @/utils/floorPlanCache ─────────────────────────────────────────────────

jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

// ─── @/utils/mapViewport ─────────────────────────────────────────────────────

jest.mock("@/utils/mapViewport", () => require("./helpers/mapMocks").createMapViewportMock());

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── Subject under test ───────────────────────────────────────────────────────

import { MapPin3D, MapPinEmoji, ZoneOverlayItem } from "@/components/WarehouseMapView";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

// ─── Access the cancelAnimation spy ──────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cancelAnimationMock = (
  require("react-native-reanimated") as { cancelAnimation: jest.Mock }
).cancelAnimation;

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeZone(overrides: Partial<ApiWarehouseZone> = {}): ApiWarehouseZone {
  return {
    id: 1,
    aisleId: "5",
    label: "05",
    sectionNum: 0,
    isInventory: true,
    svgX: 100,
    svgY: 200,
    svgWidth: 300,
    svgHeight: 400,
    sortOrder: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  } as ApiWarehouseZone;
}

const fakeColors = {
  background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
  primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
  mutedForeground: "#64748b", destructive: "#ef4444",
  success: "#22c55e", warning: "#f59e0b", accent: "#f1f5f9", accentForeground: "#000",
} as ReturnType<typeof import("@/hooks/useColors").useColors>;

const fakeScale = { value: 1 } as import("react-native-reanimated").SharedValue<number>;

// =============================================================================
// MapPin3D — cancelAnimation called on unmount
// =============================================================================

describe("MapPin3D — cancelAnimation stops the spring on cleanup", () => {
  beforeEach(() => { cancelAnimationMock.mockClear(); });

  it("calls cancelAnimation when unmounted while isNew=true", async () => {
    const result = await render(
      <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" isNew={true} />,
    );

    // cancelAnimation is called once as the effect cleanup runs on mount
    // (React 18 strict mode fires effects once in test env; cleanup fires on unmount).
    cancelAnimationMock.mockClear();

    await result.unmount();

    // After unmount the cleanup must have fired cancelAnimation.
    expect(cancelAnimationMock).toHaveBeenCalledTimes(1);
  });

  it("calls cancelAnimation when isNew flips false→true→false", async () => {
    const result = await render(
      <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" isNew={false} />,
    );

    cancelAnimationMock.mockClear();

    // Flip to isNew=true — effect fires (and its prior cleanup runs first).
    await result.rerender(
      <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" isNew={true} />,
    );

    // At least one cancelAnimation call (the cleanup of the previous effect run).
    const countAfterTrue = cancelAnimationMock.mock.calls.length;
    expect(countAfterTrue).toBeGreaterThanOrEqual(1);
    cancelAnimationMock.mockClear();

    // Flip back to isNew=false — cleanup of the isNew=true effect must cancel.
    await result.rerender(
      <MapPin3D cx={100} cy={200} size={20} fill="#f59e0b" stroke="#b45309" isNew={false} />,
    );

    expect(cancelAnimationMock).toHaveBeenCalledTimes(1);

    await result.unmount();
  });

  it("calls cancelAnimation when unmounted while isNew=false", async () => {
    const result = await render(
      <MapPin3D cx={50} cy={80} size={15} fill="#8b5cf6" stroke="#6d28d9" isNew={false} />,
    );

    cancelAnimationMock.mockClear();

    await result.unmount();

    // Even when no spring was running, cleanup must still call cancelAnimation
    // (a no-op on the native side but the JS cleanup must execute).
    expect(cancelAnimationMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// MapPinEmoji — cancelAnimation called on unmount
// =============================================================================

describe("MapPinEmoji — cancelAnimation stops the spring on cleanup", () => {
  beforeEach(() => { cancelAnimationMock.mockClear(); });

  it("calls cancelAnimation when unmounted while isNew=true", async () => {
    const result = await render(
      <MapPinEmoji cx={100} cy={200} size={20} fill="#f59e0b" isNew={true} />,
    );

    cancelAnimationMock.mockClear();

    await result.unmount();

    expect(cancelAnimationMock).toHaveBeenCalledTimes(1);
  });

  it("calls cancelAnimation when isNew flips false→true→false", async () => {
    const result = await render(
      <MapPinEmoji cx={100} cy={200} size={20} fill="#f59e0b" isNew={false} />,
    );

    cancelAnimationMock.mockClear();

    await result.rerender(
      <MapPinEmoji cx={100} cy={200} size={20} fill="#f59e0b" isNew={true} />,
    );

    const countAfterTrue = cancelAnimationMock.mock.calls.length;
    expect(countAfterTrue).toBeGreaterThanOrEqual(1);
    cancelAnimationMock.mockClear();

    await result.rerender(
      <MapPinEmoji cx={100} cy={200} size={20} fill="#f59e0b" isNew={false} />,
    );

    expect(cancelAnimationMock).toHaveBeenCalledTimes(1);

    await result.unmount();
  });

  it("calls cancelAnimation when unmounted while isNew=false", async () => {
    const result = await render(
      <MapPinEmoji cx={50} cy={80} size={15} fill="#8b5cf6" isNew={false} />,
    );

    cancelAnimationMock.mockClear();

    await result.unmount();

    expect(cancelAnimationMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// ZoneOverlayItem — cancelAnimation stops the fillOpacity animation on unmount
// =============================================================================

describe("ZoneOverlayItem — cancelAnimation stops the fillOpacity animation on cleanup", () => {
  const zone = makeZone();

  beforeEach(() => { cancelAnimationMock.mockClear(); });

  it("calls cancelAnimation when unmounted while isPinned=true", async () => {
    const result = await render(
      <ZoneOverlayItem
        zone={zone}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={false}
        isCounted={false}
        isPinned={true}
      />,
    );

    cancelAnimationMock.mockClear();

    await result.unmount();

    // The fillOpacity useEffect cleanup must call cancelAnimation on fillOpacitySV.
    // Count may be >1 because the mock useSharedValue is not a stable ref (it
    // returns a new object on every render), so the effect can fire more than once.
    expect(cancelAnimationMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("calls cancelAnimation when unmounted while isPinned=false", async () => {
    const result = await render(
      <ZoneOverlayItem
        zone={zone}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={false}
        isCounted={false}
        isPinned={false}
      />,
    );

    cancelAnimationMock.mockClear();

    await result.unmount();

    expect(cancelAnimationMock).toHaveBeenCalledTimes(1);
  });

  it("calls cancelAnimation when isPinned transitions true→false (results cleared)", async () => {
    const result = await render(
      <ZoneOverlayItem
        zone={zone}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={false}
        isCounted={false}
        isPinned={true}
      />,
    );

    cancelAnimationMock.mockClear();

    // Clearing results: isPinned goes back to false.
    await result.rerender(
      <ZoneOverlayItem
        zone={zone}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={false}
        isCounted={false}
        isPinned={false}
      />,
    );

    // The effect re-ran because isPinnedNow changed; the previous cleanup
    // (from the isPinned=true run) must have called cancelAnimation.
    // Count may be >1 due to mock useSharedValue creating a new object each render.
    expect(cancelAnimationMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    await result.unmount();
  });

  it("calls cancelAnimation when isVariantPinned transitions true→false", async () => {
    const result = await render(
      <ZoneOverlayItem
        zone={zone}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={false}
        isCounted={false}
        isVariantPinned={true}
      />,
    );

    cancelAnimationMock.mockClear();

    await result.rerender(
      <ZoneOverlayItem
        zone={zone}
        scale={fakeScale}
        colors={fakeColors}
        onZoneTap={jest.fn()}
        cycleMode={false}
        isCounted={false}
        isVariantPinned={false}
      />,
    );

    // Count may be >1 due to mock useSharedValue creating a new object each render.
    expect(cancelAnimationMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    await result.unmount();
  });
});
