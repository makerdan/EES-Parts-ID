/**
 * Behavioral regression tests: BarcodeScanModal permanent camera-permission denial.
 *
 * When `useCameraPermissions` returns `{ granted: false, canAskAgain: false }`
 * (iOS permanent denial), the modal must:
 *   - render "Open Settings" (not "Allow Camera Access")
 *   - call Linking.openSettings when that button is tapped
 *   - NOT call requestPermission at any point
 *
 * These mount the real component with mocked dependencies so that regressions
 * to the actual rendering and tap-handler wiring are caught at runtime.
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ─── Stable mock refs for useCameraPermissions ───────────────────────────────
// Must be declared at module scope so the same object/function references are
// returned on every render — if useCameraPermissions returns new refs each call,
// the useEffect dependency array sees a change and re-fires on every state update,
// which can mask or multiply side effects in tests.

const mockPermissionDenied = { granted: false, canAskAgain: false };
const mockRequestPermission = jest.fn();
const mockPermissionCanAsk  = { granted: false, canAskAgain: true };

// ─── expo-camera ─────────────────────────────────────────────────────────────

jest.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: jest.fn(() => [mockPermissionDenied, mockRequestPermission]),
}));

// ─── @tanstack/react-query ────────────────────────────────────────────────────

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

// ─── @workspace/api-client-react ─────────────────────────────────────────────

jest.mock("@workspace/api-client-react", () => ({
  useUpdateItemBarcodes: jest.fn(() => ({ mutateAsync: jest.fn() })),
  lookupByBarcode: jest.fn(),
}));

// ─── @/components/CatalogPickerModal ─────────────────────────────────────────

jest.mock("@/components/CatalogPickerModal", () => ({
  CatalogPickerModal: () => null,
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── @/hooks/useScanHistory ───────────────────────────────────────────────────

jest.mock("@/hooks/useScanHistory", () => ({
  useScanHistory: jest.fn(() => ({ history: [], addEntry: jest.fn() })),
}));

// ─── @/utils/editItemCache ────────────────────────────────────────────────────

jest.mock("@/utils/editItemCache", () => ({
  invalidateListCache: jest.fn().mockResolvedValue(undefined),
}));

// ─── @/utils/offlineBarcode ───────────────────────────────────────────────────

jest.mock("@/utils/offlineBarcode", () => ({
  lookupByBarcodeOffline:  jest.fn().mockResolvedValue(null),
  upsertItemInBarcodeCache: jest.fn().mockResolvedValue(undefined),
}));

// ─── AppContext (via moduleNameMapper → __mocks__/contexts/AppContext.js) ─────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── Subject under test ───────────────────────────────────────────────────────

import { BarcodeScanModal } from "../components/BarcodeScanModal";

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

function allTextStrings(root: Inst): string[] {
  const out: string[] = [];
  function walk(node: Inst | string) {
    if (typeof node === "string") { if (node.trim()) out.push(node.trim()); return; }
    if ((node.type as string) === "Text") {
      out.push(instText(node));
    }
    (node.children ?? []).forEach((c: TestInstance | string) => walk(c as Inst | string));
  }
  walk(root);
  return out;
}

// ─── Per-test setup/teardown ──────────────────────────────────────────────────

const mockOnClose = jest.fn();
const mockOnFound = jest.fn();
let activeTree: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  useApp.mockReturnValue({ isAdmin: false, settings: { scanSound: true } });
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const { useCameraPermissions } = require("expo-camera") as { useCameraPermissions: jest.Mock };

async function renderModal(
  permissionState = mockPermissionDenied,
  requestPermFn = mockRequestPermission,
) {
  (useCameraPermissions as jest.Mock).mockReturnValue([permissionState, requestPermFn]);
  const result = await render(
    <BarcodeScanModal visible={true} onClose={mockOnClose} onFound={mockOnFound} />,
  );
  activeTree = result;
  return result;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BarcodeScanModal — permanent camera denial (canAskAgain === false)", () => {

  it("renders 'Open Settings' when camera permission is permanently denied", async () => {
    const result = await renderModal();
    const texts = allTextStrings(result.root!).join(" ");
    expect(texts).toContain("Open Settings");
  });

  it("does NOT render 'Allow Camera Access' when canAskAgain is false", async () => {
    const result = await renderModal();
    const texts = allTextStrings(result.root!).join(" ");
    expect(texts).not.toContain("Allow Camera Access");
  });

  it("tapping 'Open Settings' calls Linking.openSettings", async () => {
    const { Linking } = require("react-native") as typeof import("react-native");
    const result = await renderModal();

    const btn = findPressable(result.root!, "Open Settings");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it("tapping 'Open Settings' does NOT call requestPermission", async () => {
    const result = await renderModal();

    const btn = findPressable(result.root!, "Open Settings");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it("does NOT call requestPermission just by mounting the modal", async () => {
    await renderModal();
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it("includes an explanatory message about permanent denial", async () => {
    const result = await renderModal();
    const texts = allTextStrings(result.root!).join(" ");
    expect(texts).toMatch(/permanently denied/i);
  });

  it("mentions Settings in the denial explanation so the user knows where to go", async () => {
    const result = await renderModal();
    const texts = allTextStrings(result.root!).join(" ");
    expect(texts).toMatch(/Settings/);
  });
});

describe("BarcodeScanModal — non-permanent denial (canAskAgain === true)", () => {
  const mockRequestPermission2 = jest.fn();

  it("renders 'Allow Camera Access' (not 'Open Settings') when canAskAgain is true", async () => {
    const result = await renderModal(mockPermissionCanAsk, mockRequestPermission2);
    const texts = allTextStrings(result.root!).join(" ");
    expect(texts).toContain("Allow Camera Access");
    expect(texts).not.toContain("Open Settings");
  });

  it("tapping 'Allow Camera Access' calls requestPermission", async () => {
    const result = await renderModal(mockPermissionCanAsk, mockRequestPermission2);

    const btn = findPressable(result.root!, "Allow Camera Access");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(mockRequestPermission2).toHaveBeenCalledTimes(1);
  });

  it("tapping 'Allow Camera Access' does NOT call Linking.openSettings", async () => {
    const { Linking } = require("react-native") as typeof import("react-native");
    const result = await renderModal(mockPermissionCanAsk, mockRequestPermission2);

    const btn = findPressable(result.root!, "Allow Camera Access");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(Linking.openSettings).not.toHaveBeenCalled();
  });
});
