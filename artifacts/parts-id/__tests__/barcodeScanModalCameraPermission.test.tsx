/**
 * @jest-environment node
 *
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
import renderer, { act } from "react-test-renderer";

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

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#000",
    card: "#fff",
    border: "#ccc",
    primary: "#3b82f6",
    primaryForeground: "#fff",
    muted: "#f1f5f9",
    mutedForeground: "#64748b",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#f59e0b",
  }),
}));

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

// ─── Suppress react-test-renderer deprecation noise ──────────────────────────

beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation((msg: unknown, ...args: unknown[]) => {
    if (typeof msg === "string" && (
      msg.includes("react-test-renderer is deprecated") ||
      msg.includes("Warning:")
    )) return;
    // eslint-disable-next-line no-console
    console.warn(msg, ...args);
  });
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Tree-walking helpers ─────────────────────────────────────────────────────

type Inst = renderer.ReactTestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(c => instText(c as Inst | string)).join("");
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .findAll(n => (n.type as string) === "rn-pressable", { deep: true })
      .find(n => instText(n).includes(label)) ?? null
  );
}

function allTextStrings(root: Inst): string[] {
  const out: string[] = [];
  function walk(node: Inst | string) {
    if (typeof node === "string") { if (node.trim()) out.push(node.trim()); return; }
    if ((node.type as string) === "rn-text") {
      out.push(instText(node));
    }
    (node.children ?? []).forEach(c => walk(c as Inst | string));
  }
  walk(root);
  return out;
}

// ─── Per-test setup/teardown ──────────────────────────────────────────────────

const mockOnClose = jest.fn();
const mockOnFound = jest.fn();
let activeTree: renderer.ReactTestRenderer | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  useApp.mockReturnValue({ isAdmin: false, settings: { scanSound: true } });
});

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
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
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <BarcodeScanModal visible={true} onClose={mockOnClose} onFound={mockOnFound} />,
    );
  });
  activeTree = tree;
  return tree;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BarcodeScanModal — permanent camera denial (canAskAgain === false)", () => {

  it("renders 'Open Settings' when camera permission is permanently denied", async () => {
    const tree = await renderModal();
    const texts = allTextStrings(tree.root).join(" ");
    expect(texts).toContain("Open Settings");
  });

  it("does NOT render 'Allow Camera Access' when canAskAgain is false", async () => {
    const tree = await renderModal();
    const texts = allTextStrings(tree.root).join(" ");
    expect(texts).not.toContain("Allow Camera Access");
  });

  it("tapping 'Open Settings' calls Linking.openSettings", async () => {
    const { Linking } = require("react-native") as typeof import("react-native");
    const tree = await renderModal();

    const btn = findPressable(tree.root, "Open Settings");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it("tapping 'Open Settings' does NOT call requestPermission", async () => {
    const tree = await renderModal();

    const btn = findPressable(tree.root, "Open Settings");
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
    const tree = await renderModal();
    const texts = allTextStrings(tree.root).join(" ");
    expect(texts).toMatch(/permanently denied/i);
  });

  it("mentions Settings in the denial explanation so the user knows where to go", async () => {
    const tree = await renderModal();
    const texts = allTextStrings(tree.root).join(" ");
    expect(texts).toMatch(/Settings/);
  });
});

describe("BarcodeScanModal — non-permanent denial (canAskAgain === true)", () => {
  const mockRequestPermission2 = jest.fn();

  it("renders 'Allow Camera Access' (not 'Open Settings') when canAskAgain is true", async () => {
    const tree = await renderModal(mockPermissionCanAsk, mockRequestPermission2);
    const texts = allTextStrings(tree.root).join(" ");
    expect(texts).toContain("Allow Camera Access");
    expect(texts).not.toContain("Open Settings");
  });

  it("tapping 'Allow Camera Access' calls requestPermission", async () => {
    const tree = await renderModal(mockPermissionCanAsk, mockRequestPermission2);

    const btn = findPressable(tree.root, "Allow Camera Access");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(mockRequestPermission2).toHaveBeenCalledTimes(1);
  });

  it("tapping 'Allow Camera Access' does NOT call Linking.openSettings", async () => {
    const { Linking } = require("react-native") as typeof import("react-native");
    const tree = await renderModal(mockPermissionCanAsk, mockRequestPermission2);

    const btn = findPressable(tree.root, "Allow Camera Access");
    expect(btn).not.toBeNull();

    await act(async () => {
      (btn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(Linking.openSettings).not.toHaveBeenCalled();
  });
});
