/**
 * @jest-environment node
 *
 * Contract tests for MeasurePartScreen.
 *
 * Uses renderer.root.findAll() (instance tree API) rather than toJSON() because
 * toJSON() in react-test-renderer@19 can silently drop conditional children
 * that haven't been flushed through act() yet.
 *
 * Exercises:
 *   - isLiDARCapableDevice() — exported pure function
 *   - Phase transition: preview → lidar_scanning → confirm (happy path)
 *   - Phase transition: preview → lidar_scanning → preview (error path)
 *   - Manual entry shortcut (goManual)
 *   - onConfirm callback with parsed dimensions
 */

// Required for act() to work correctly in the node test environment.
// Without this flag React 19 logs "not configured to support act()" warnings
// for every state update that occurs inside act() boundaries.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
// TODO: react-test-renderer is deprecated in React 19 and will be removed in a
// future release.  Migrate to @testing-library/react-native once the
// MeasurePartScreen mocking surface stabilises.
import renderer, { act } from "react-test-renderer";

// ─── Module mocks ─────────────────────────────────────────────────────────────

// Transitive mocks for AppContext (expo-secure-store ships as ESM and cannot be
// transformed by Jest; the remaining mocks silence its other imports).
jest.mock("@workspace/api-client-react", () => ({
  setAuthTokenGetter: jest.fn(),
}));

jest.mock("../utils/logoutRegistry", () => ({
  LogoutRegistry: class {
    register() { return () => {}; }
    fire() {}
  },
}));

jest.mock("../utils/sessionStorage", () => ({
  SEARCH_CACHE_KEYS: [],
  SESSION_KEY: "parts_id_session",
  ADMIN_TOKEN_KEY: "parts_id_admin_token",
  clearSessionStorage: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/constants/colors", () => ({
  __esModule: true,
  default: {
    light: { background: "#fff", foreground: "#000", card: "#fff", border: "#ccc", primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9", mutedForeground: "#64748b", destructive: "#ef4444", success: "#22c55e", warning: "#f59e0b" },
    dark:  { background: "#000", foreground: "#fff", card: "#111", border: "#333", primary: "#3b82f6", primaryForeground: "#fff", muted: "#1e293b", mutedForeground: "#94a3b8", destructive: "#ef4444", success: "#22c55e", warning: "#f59e0b" },
    radius: 8,
  },
}));

// Mock AppContext so MeasurePartScreen can call useApp() without an AppProvider.
// The component only reads settings.dimensionUnit and calls updateSetting.
jest.mock("@/contexts/AppContext", () => ({
  useApp: jest.fn(() => ({
    settings: { dimensionUnit: "mm" },
    updateSetting: jest.fn(),
  })),
}));

jest.mock("lidar-measure", () => ({
  isLiDARSupported: jest.fn().mockReturnValue(false),
  measureObject: jest.fn().mockRejectedValue(
    new Error("LiDAR not available in test environment")
  ),
  cancelMeasure: jest.fn(),
  NativeLidarDepthView: null,
}));

// Both `permission` and `requestPermission` must be stable references across
// renders.  If either is a new object/function per render, the component's
// useEffect (deps: [visible, initialDims, permission, requestPermission])
// re-fires after every state update and resets phase back to "preview",
// cancelling any phase transition we want to test.
jest.mock("expo-camera", () => {
  const permission = { granted: true };
  const requestPermission = jest.fn().mockResolvedValue({ granted: true });
  return {
    CameraView: function CameraView() { return null; },
    useCameraPermissions: jest.fn(() => [permission, requestPermission]),
  };
});

jest.mock("expo-device", () => ({ modelName: null }));

jest.mock("@expo/vector-icons", () => ({
  Feather: function Feather() { return null; },
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({ background: "#fff", text: "#000", primary: "#3b82f6" }),
}));

// ─── Typed handles to mocks ───────────────────────────────────────────────────

import { isLiDARSupported, measureObject } from "lidar-measure";
const mockIsLiDARSupported = isLiDARSupported as jest.Mock;
const mockMeasureObject = measureObject as jest.Mock;

import { Alert, AppState } from "react-native";
const mockAlert = Alert.alert as jest.Mock;
const mockAppStateAddListener = AppState.addEventListener as jest.Mock;

// ─── Component under test ─────────────────────────────────────────────────────

import {
  MeasurePartScreen,
  isLiDARCapableDevice,
  type PartDimensions,
} from "../components/MeasurePartScreen";

// ─── Instance-tree helpers ────────────────────────────────────────────────────

type TestInst = renderer.ReactTestInstance;

/** Recursively concatenate all string leaf nodes. */
function instText(node: TestInst | string): string {
  if (typeof node === "string") return node;
  return node.children.map(c => instText(c as TestInst | string)).join("");
}

/** Find all host instances of the given tag (e.g. "rn-pressable"). */
function findByTag(root: TestInst, tag: string): TestInst[] {
  return root.findAll(n => n.type === tag, { deep: true });
}

/** Find the first "rn-pressable" instance whose text content includes `text`. */
function findPressable(root: TestInst, text: string): TestInst | null {
  return findByTag(root, "rn-pressable").find(n => instText(n).includes(text)) ?? null;
}

/** True if any node in the tree contains `text`. */
function hasText(root: TestInst, text: string): boolean {
  return instText(root).includes(text);
}

// ─── Per-test cleanup state ───────────────────────────────────────────────────

/**
 * Track the active renderer and any pending measureObject reject so afterEach
 * can tear them down.  Unresolved promises and un-removed AppState listeners
 * are the two sources of open-handle warnings / hangs in Jest.
 */
let activeTree: renderer.ReactTestRenderer | null = null;
let rejectPendingMeasure: ((e: Error) => void) | null = null;

// ─── Suppress react-test-renderer deprecation warning ────────────────────────
// react-test-renderer is deprecated in React 19.  Suppress the noisy console
// warning here until this suite is migrated to @testing-library/react-native.
let originalConsoleError: typeof console.error;
beforeAll(() => {
  originalConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation((msg: unknown, ...args: unknown[]) => {
    if (typeof msg === "string" && msg.includes("react-test-renderer is deprecated")) return;
    originalConsoleError(msg, ...args);
  });
});
afterAll(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ─── Render helper (wraps in act so effects flush before assertions) ──────────

async function render(ui: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(ui);
  });
  activeTree = tree;
  return tree;
}

// Press a button by label, wrapped in act so resulting state updates flush.
async function press(root: TestInst, label: string) {
  const btn = findPressable(root, label);
  if (!btn) throw new Error(`Button "${label}" not found`);
  await act(async () => {
    (btn.props.onPress as () => void)();
  });
}

// Flush any resolved promises (one microtask tick).
const flushPromises = () => act(async () => { await Promise.resolve(); });

const DEFAULT_PROPS = {
  visible: true,
  onClose: jest.fn(),
  onConfirm: jest.fn(),
  initialDims: null,
  adminToken: "test-token",
};

afterEach(async () => {
  // Settle any pending measureObject promise so its microtask chain doesn't
  // linger after the test ends (open-handle source #1).
  if (rejectPendingMeasure) {
    rejectPendingMeasure(new Error("test cleanup"));
    rejectPendingMeasure = null;
  }
  // Unmount the renderer tree so the component's cleanup effects run and the
  // AppState subscription is removed (open-handle source #2).
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  jest.clearAllMocks();
});

// ─── isLiDARCapableDevice ─────────────────────────────────────────────────────

describe("isLiDARCapableDevice()", () => {
  let ExpoDevice: { modelName: string | null };
  beforeEach(() => { ExpoDevice = require("expo-device"); });

  it("returns true when modelName is null (unknown / simulator)", () => {
    ExpoDevice.modelName = null;
    expect(isLiDARCapableDevice()).toBe(true);
  });

  it("returns true for iPhone 12 Pro", () => {
    ExpoDevice.modelName = "iPhone 12 Pro";
    expect(isLiDARCapableDevice()).toBe(true);
  });

  it("returns true for iPhone 15 Pro Max", () => {
    ExpoDevice.modelName = "iPhone 15 Pro Max";
    expect(isLiDARCapableDevice()).toBe(true);
  });

  it("returns true for iPad Pro", () => {
    ExpoDevice.modelName = "iPad Pro (12.9-inch) (4th generation)";
    expect(isLiDARCapableDevice()).toBe(true);
  });

  it("returns false for iPhone 11 (no LiDAR)", () => {
    ExpoDevice.modelName = "iPhone 11";
    expect(isLiDARCapableDevice()).toBe(false);
  });

  it("returns false for iPhone SE (3rd generation)", () => {
    ExpoDevice.modelName = "iPhone SE (3rd generation)";
    expect(isLiDARCapableDevice()).toBe(false);
  });

  it("returns false for iPad Air", () => {
    ExpoDevice.modelName = "iPad Air (5th generation)";
    expect(isLiDARCapableDevice()).toBe(false);
  });
});

// ─── Preview phase ────────────────────────────────────────────────────────────

describe("MeasurePartScreen – preview phase", () => {
  it("renders null when visible=false", async () => {
    mockIsLiDARSupported.mockReturnValue(false);
    const tree = await render(
      <MeasurePartScreen {...DEFAULT_PROPS} visible={false} />
    );
    expect(tree.toJSON()).toBeNull();
  });

  it('shows "Measure Part" in the header', async () => {
    mockIsLiDARSupported.mockReturnValue(false);
    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(hasText(tree.root, "Measure Part")).toBe(true);
  });

  it("shows LiDAR scan button when lidar is available", async () => {
    mockIsLiDARSupported.mockReturnValue(true);
    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(findPressable(tree.root, "Scan with LiDAR")).not.toBeNull();
  });

  it("does not show LiDAR scan button when lidar is unavailable", async () => {
    mockIsLiDARSupported.mockReturnValue(false);
    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(findPressable(tree.root, "Scan with LiDAR")).toBeNull();
  });

  it('shows "Enter manually instead" link always', async () => {
    mockIsLiDARSupported.mockReturnValue(false);
    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(hasText(tree.root, "Enter manually instead")).toBe(true);
  });

  it("shows LiDAR unsupported message when lidar is unavailable", async () => {
    mockIsLiDARSupported.mockReturnValue(false);
    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(hasText(tree.root, "LiDAR measurement requires a LiDAR-capable device")).toBe(true);
  });

  it("does not show LiDAR unsupported message when lidar is available", async () => {
    mockIsLiDARSupported.mockReturnValue(true);
    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(hasText(tree.root, "LiDAR measurement requires a LiDAR-capable device")).toBe(false);
  });
});

// ─── Manual entry shortcut ────────────────────────────────────────────────────

describe("MeasurePartScreen – manual entry shortcut", () => {
  it('transitions to confirm phase when "Enter manually instead" is pressed', async () => {
    mockIsLiDARSupported.mockReturnValue(false);
    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    await press(tree.root, "Enter manually instead");
    expect(hasText(tree.root, "Review Dimensions")).toBe(true);
  });
});

// ─── Phase: lidar_scanning → confirm (success) ───────────────────────────────

describe("MeasurePartScreen – lidar_scanning → confirm (happy path)", () => {
  it('shows "LiDAR Scanning…" header immediately after pressing Scan', async () => {
    mockIsLiDARSupported.mockReturnValue(true);

    let resolveScanning!: (v: { length: number; width: number; height: number }) => void;
    mockMeasureObject.mockReturnValue(
      new Promise((res, rej) => { resolveScanning = res; rejectPendingMeasure = rej; })
    );

    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(findPressable(tree.root, "Scan with LiDAR")).not.toBeNull();

    await press(tree.root, "Scan with LiDAR");
    expect(hasText(tree.root, "LiDAR Scanning")).toBe(true);

    resolveScanning({ length: 200, width: 100, height: 50 });
    rejectPendingMeasure = null;
    await flushPromises();
  });

  it('transitions to "Review Dimensions" after measureObject resolves', async () => {
    mockIsLiDARSupported.mockReturnValue(true);
    mockMeasureObject.mockResolvedValue({ length: 200, width: 100, height: 50 });

    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    await press(tree.root, "Scan with LiDAR");
    await flushPromises();

    expect(hasText(tree.root, "Review Dimensions")).toBe(true);
  });

  it("populates dimension fields with values from measureObject", async () => {
    mockIsLiDARSupported.mockReturnValue(true);
    mockMeasureObject.mockResolvedValue({ length: 200, width: 100, height: 50 });

    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    await press(tree.root, "Scan with LiDAR");
    await flushPromises();

    expect(hasText(tree.root, "200 × 100 × 50 mm")).toBe(true);
  });

  it("calls measureObject with the 4-second timeout constant", async () => {
    mockIsLiDARSupported.mockReturnValue(true);
    mockMeasureObject.mockResolvedValue({ length: 100, width: 80, height: 60 });

    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    await press(tree.root, "Scan with LiDAR");
    await flushPromises();

    expect(mockMeasureObject).toHaveBeenCalledWith(4);
  });
});

// ─── Phase: lidar_scanning → preview (error) ─────────────────────────────────

describe("MeasurePartScreen – lidar_scanning → preview (error path)", () => {
  it("returns to preview phase when measureObject rejects", async () => {
    mockIsLiDARSupported.mockReturnValue(true);
    mockMeasureObject.mockRejectedValue(new Error("ERR_NO_MESH"));

    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    await press(tree.root, "Scan with LiDAR");
    await flushPromises();

    expect(hasText(tree.root, "Measure Part")).toBe(true);
  });

  it("shows the error message from the native module via Alert", async () => {
    mockIsLiDARSupported.mockReturnValue(true);
    mockMeasureObject.mockRejectedValue(new Error("ERR_NO_MESH"));

    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    await press(tree.root, "Scan with LiDAR");
    await flushPromises();

    expect(mockAlert).toHaveBeenCalledWith(
      "LiDAR scan failed",
      expect.stringContaining("ERR_NO_MESH")
    );
  });

  it("uses a generic fallback message when the rejection is not an Error", async () => {
    mockIsLiDARSupported.mockReturnValue(true);
    mockMeasureObject.mockRejectedValue("non-error string rejection");

    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    await press(tree.root, "Scan with LiDAR");
    await flushPromises();

    expect(mockAlert).toHaveBeenCalledWith(
      "LiDAR scan failed",
      expect.stringContaining("LiDAR scan failed")
    );
  });
});

// ─── Phase: lidar_scanning → preview (AppState background interrupt) ─────────

describe("MeasurePartScreen – lidar_scanning → preview (background interrupt)", () => {
  /**
   * Helper: start a scan that stays pending, then fire the AppState listener
   * with the given nextState, then assert the phase resets to preview.
   */
  async function runInterruptTest(nextState: "background" | "inactive") {
    mockIsLiDARSupported.mockReturnValue(true);
    // Never resolves during the test — we want the scan to still be in-flight.
    // Capture the reject so afterEach can settle it and prevent an open handle.
    mockMeasureObject.mockReturnValue(
      new Promise((_, rej) => { rejectPendingMeasure = rej; })
    );

    const tree = await render(<MeasurePartScreen {...DEFAULT_PROPS} />);
    await press(tree.root, "Scan with LiDAR");

    // The component must now be in lidar_scanning phase and have registered
    // an AppState listener.  Grab the change-handler from the mock.
    expect(mockAppStateAddListener).toHaveBeenCalledWith("change", expect.any(Function));
    const changeHandler: (s: string) => void =
      mockAppStateAddListener.mock.calls[mockAppStateAddListener.mock.calls.length - 1][1];

    // Simulate the app moving to background / inactive while scanning.
    await act(async () => {
      changeHandler(nextState);
    });

    expect(hasText(tree.root, "Measure Part")).toBe(true);
  }

  it("resets to preview when app moves to background mid-scan", async () => {
    await runInterruptTest("background");
  });

  it("resets to preview when app becomes inactive mid-scan", async () => {
    await runInterruptTest("inactive");
  });
});

// ─── onConfirm callback ───────────────────────────────────────────────────────

describe("MeasurePartScreen – onConfirm callback", () => {
  it("fires onConfirm with parsed dimensions after a successful LiDAR scan", async () => {
    const onConfirm = jest.fn();
    mockIsLiDARSupported.mockReturnValue(true);
    mockMeasureObject.mockResolvedValue({ length: 200, width: 100, height: 50 });

    const tree = await render(
      <MeasurePartScreen {...DEFAULT_PROPS} onConfirm={onConfirm} />
    );
    await press(tree.root, "Scan with LiDAR");
    await flushPromises();
    await press(tree.root, "Save Dimensions");

    expect(onConfirm).toHaveBeenCalledWith<[PartDimensions]>({
      length: 200,
      width: 100,
      height: 50,
      diameter: null,
    });
  });

  it("fires onConfirm with null values when fields are empty (manual entry)", async () => {
    const onConfirm = jest.fn();
    mockIsLiDARSupported.mockReturnValue(false);

    const tree = await render(
      <MeasurePartScreen {...DEFAULT_PROPS} onConfirm={onConfirm} />
    );
    await press(tree.root, "Enter manually instead");
    await press(tree.root, "Save Dimensions");

    expect(onConfirm).toHaveBeenCalledWith<[PartDimensions]>({
      length: null,
      width: null,
      height: null,
      diameter: null,
    });
  });
});
