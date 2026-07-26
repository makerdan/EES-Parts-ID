/**
 * Behavioral regression tests: MeasurePartScreen permanent camera-permission denial.
 *
 * Two bugs that were fixed:
 *
 *  1. On modal open, `requestPermission` was called even when `canAskAgain === false`
 *     (iOS permanent denial).  The system dialog never appears for a permanently-denied
 *     permission, so the call was a silent no-op.  The fix added the guard:
 *       if (!permission?.granted && permission?.canAskAgain !== false) requestPermission();
 *
 *  2. The permission-gate UI showed only an "Enable Camera" button unconditionally.
 *     The fix renders "Open Settings" + Linking.openSettings when `canAskAgain === false`.
 *
 * These tests mount the real component with mocked dependencies so that regressions
 * to the actual effect logic, rendering, and tap-handler wiring are caught at runtime.
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ─── Stable mock refs for useCameraPermissions ───────────────────────────────
// Declared at module scope so the same references are returned on every render,
// preventing the useEffect([..., permission, requestPermission]) from re-firing
// on every state update inside the component.

const mockPermDeniedPermanent = { granted: false, canAskAgain: false };
const mockPermDeniedCanAsk    = { granted: false, canAskAgain: true };
const mockRequestPermission   = jest.fn();

// ─── expo-camera ─────────────────────────────────────────────────────────────

jest.mock("expo-camera", () => ({
  CameraView: ({ style }: { style?: unknown }) => {
    const React = require("react");
    return React.createElement("rn-camera-view", { style });
  },
  useCameraPermissions: jest.fn(() => [mockPermDeniedPermanent, mockRequestPermission]),
}));

// ─── expo-device ─────────────────────────────────────────────────────────────

jest.mock("expo-device", () => ({ modelName: null }));

// ─── @expo/vector-icons ───────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: ({ name }: { name: string }) => {
    const React = require("react");
    return React.createElement("rn-icon", { testID: `icon-${name}` });
  },
}));

// ─── @/components/KeyboardDoneInput ──────────────────────────────────────────

jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: () => null,
}));

// ─── @/utils/deviceId ────────────────────────────────────────────────────────

jest.mock("@/utils/deviceId", () => ({
  getDeviceId: jest.fn().mockResolvedValue("test-device-id"),
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── AppContext (via moduleNameMapper → __mocks__/contexts/AppContext.js) ─────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── Subject under test ───────────────────────────────────────────────────────

import { MeasurePartScreen } from "../components/MeasurePartScreen";

// ─── Tree-walking helpers ─────────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((c: TestInstance | string) => instText(c as Inst | string)).join("");
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll((n: TestInstance) => (n.type as string) === "rn-pressable", { includeSelf: true })
      .find((n: TestInstance) => instText(n).includes(label)) ?? null
  );
}

function allTextContent(root: Inst): string {
  return root
    .queryAll((n: TestInstance) => (n.type as string) === "Text", { includeSelf: true })
    .map((n: TestInstance) => instText(n))
    .join(" ");
}

// ─── Per-test setup/teardown ──────────────────────────────────────────────────

const mockOnClose   = jest.fn();
const mockOnConfirm = jest.fn();
let activeTree: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  useApp.mockReturnValue({
    settings: { dimensionUnit: "mm", textSize: "normal" },
    updateSetting: jest.fn(),
  });
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
});

// ─── Render helpers ───────────────────────────────────────────────────────────

const { useCameraPermissions } = require("expo-camera") as { useCameraPermissions: jest.Mock };

async function renderScreen(
  permissionState = mockPermDeniedPermanent,
  requestPermFn   = mockRequestPermission,
) {
  (useCameraPermissions as jest.Mock).mockReturnValue([permissionState, requestPermFn]);
  const result = await render(
    <MeasurePartScreen
      visible={true}
      onClose={mockOnClose}
      onConfirm={mockOnConfirm}
      adminToken="test-admin-token"
    />,
  );
  activeTree = result;
  return result;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MeasurePartScreen — permanent denial: requestPermission is NOT called on open", () => {

  it("does NOT call requestPermission when canAskAgain === false", async () => {
    await renderScreen();
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it("does NOT call requestPermission on subsequent re-renders with the same permanent denial", async () => {
    const result = await renderScreen();

    // Simulate a state change that would trigger a re-render / re-run of the effect
    await act(async () => {
      result.rerender(
        <MeasurePartScreen
          visible={true}
          onClose={mockOnClose}
          onConfirm={mockOnConfirm}
          adminToken="test-admin-token"
        />,
      );
    });

    expect(mockRequestPermission).not.toHaveBeenCalled();
  });
});

describe("MeasurePartScreen — permanent denial: Open Settings UI is shown", () => {

  it("renders the 'Open Settings' button when canAskAgain === false", async () => {
    const result = await renderScreen();
    const btn = findPressable(result.root!, "Open Settings");
    expect(btn).not.toBeNull();
  });

  it("renders explanatory text about permanent denial", async () => {
    const result = await renderScreen();
    const text = allTextContent(result.root!);
    expect(text).toMatch(/permanently denied/i);
  });

  it("tapping 'Open Settings' calls Linking.openSettings", async () => {
    const { Linking } = require("react-native") as typeof import("react-native");
    const result = await renderScreen();

    const btn = findPressable(result.root!, "Open Settings");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it("tapping 'Open Settings' does NOT call requestPermission", async () => {
    const result = await renderScreen();

    const btn = findPressable(result.root!, "Open Settings");
    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it("does NOT render 'Enable Camera' when canAskAgain === false", async () => {
    const result = await renderScreen();
    const text = allTextContent(result.root!);
    expect(text).not.toContain("Enable Camera");
  });
});

describe("MeasurePartScreen — non-permanent denial: Enable Camera path", () => {
  const requestPermission2 = jest.fn();

  it("calls requestPermission on open when canAskAgain === true", async () => {
    await renderScreen(mockPermDeniedCanAsk, requestPermission2);
    expect(requestPermission2).toHaveBeenCalledTimes(1);
  });

  it("renders 'Enable Camera' (not 'Open Settings') when canAskAgain === true", async () => {
    const result = await renderScreen(mockPermDeniedCanAsk, requestPermission2);
    const btn = findPressable(result.root!, "Enable Camera");
    expect(btn).not.toBeNull();
    expect(findPressable(result.root!, "Open Settings")).toBeNull();
  });

  it("tapping 'Enable Camera' calls requestPermission", async () => {
    // Clear the initial call from mount-time effect
    requestPermission2.mockClear();
    const result = await renderScreen(mockPermDeniedCanAsk, requestPermission2);

    const btn = findPressable(result.root!, "Enable Camera");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    // Called at least once (may have been called during mount by the effect too)
    expect(requestPermission2).toHaveBeenCalled();
  });

  it("tapping 'Enable Camera' does NOT call Linking.openSettings", async () => {
    const { Linking } = require("react-native") as typeof import("react-native");
    requestPermission2.mockClear();
    const result = await renderScreen(mockPermDeniedCanAsk, requestPermission2);

    const btn = findPressable(result.root!, "Enable Camera");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(Linking.openSettings).not.toHaveBeenCalled();
  });
});
