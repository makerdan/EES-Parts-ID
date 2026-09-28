/**
 * @jest-environment node
 *
 * Contract tests for MeasurePartScreen.
 *
 * Uses result.root!.queryAll() (instance tree API) rather than toJSON() because
 * toJSON() in react-test-renderer@19 can silently drop conditional children
 * that haven't been flushed through act() yet.
 *
 * Exercises manual entry, AI photo estimation, and confirmation callbacks.
 */

// Required for act() to work correctly in the node test environment.
// Without this flag React 19 logs "not configured to support act()" warnings
// for every state update that occurs inside act() boundaries.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ─── Module mocks ─────────────────────────────────────────────────────────────

// Transitive mocks for AppContext (expo-secure-store ships as ESM and cannot be
// transformed by Jest; the remaining mocks silence its other imports).
jest.mock("@workspace/api-client-react", () => ({
  setAuthTokenGetter: jest.fn(),
}));

jest.mock("../utils/logoutRegistry", () => {
  const actual = jest.requireActual<typeof import("../utils/logoutRegistry")>("../utils/logoutRegistry");
  return {
    ...actual,
    LogoutRegistry: class {
      register() { return () => {}; }
      fire() {}
    },
  };
});

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

// Both `permission` and `requestPermission` must be stable references across
// renders.  If either is a new object/function per render, the component's
// useEffect (deps: [visible, initialDims, permission, requestPermission])
// re-fires after every state update and resets phase back to "preview",
// cancelling any phase transition we want to test.
jest.mock("expo-camera", () => {
  const React = require("react");
  const permission = { granted: true };
  const requestPermission = jest.fn().mockResolvedValue({ granted: true });
  // Stable mock for takePictureAsync — exposed via __mockTakePictureAsync so
  // tests that exercise the AI photo-estimate path can configure it per call.
  const mockTakePictureAsync = jest.fn();
  return {
    // forwardRef so cameraRef.current is populated with the imperative handle
    // that exposes takePictureAsync.  Plain function components don't forward
    // refs, which would leave cameraRef.current null and cause handleCapture to
    // return early before reaching the fetch call we want to assert on.
    CameraView: React.forwardRef(function CameraView(
      _props: Record<string, unknown>,
      ref: React.Ref<{ takePictureAsync: jest.Mock }>
    ) {
      React.useImperativeHandle(ref, () => ({ takePictureAsync: mockTakePictureAsync }));
      return null;
    }),
    useCameraPermissions: jest.fn(() => [permission, requestPermission]),
    __mockTakePictureAsync: mockTakePictureAsync,
  };
});

jest.mock("@expo/vector-icons", () => ({
  Feather: function Feather() { return null; },
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── Typed handles to mocks ───────────────────────────────────────────────────

import { Alert } from "react-native";
const mockAlert = Alert.alert as jest.Mock;

// ─── Component under test ─────────────────────────────────────────────────────

import {
  MeasurePartScreen,
  type PartDimensions,
} from "../components/MeasurePartScreen";

// ─── Instance-tree helpers ────────────────────────────────────────────────────

type TestInst = TestInstance;

/** Recursively concatenate all string leaf nodes. */
function instText(node: TestInst | string): string {
  if (typeof node === "string") return node;
  return node.children.map((c: TestInst | string) => instText(c as TestInst | string)).join("");
}

/** Find all host instances of the given tag (e.g. "rn-pressable"). */
function findByTag(root: TestInst, tag: string): TestInst[] {
  return root.queryAll((n: TestInst) => n.type === tag, { includeSelf: true });
}

/** Find the first "rn-pressable" instance whose text content includes `text`. */
function findPressable(root: TestInst, text: string): TestInst | null {
  return findByTag(root, "rn-pressable").find((n: TestInst) => instText(n).includes(text)) ?? null;
}

/** True if any node in the tree contains `text`. */
function hasText(root: TestInst, text: string): boolean {
  return instText(root).includes(text);
}

/** Collect all non-empty `value` props from rn-text-input nodes in the tree. */
function findInputValues(root: TestInst): string[] {
  return root
    .queryAll((n: TestInst) => (n.type as string) === "rn-text-input", { includeSelf: true })
    .map((n: TestInst) => String(n.props.value ?? ""))
    .filter(Boolean);
}

// ─── Per-test cleanup state ───────────────────────────────────────────────────

/**
 * Track the active renderer and any pending measureObject reject so afterEach
 * can tear them down.  Unresolved promises and un-removed AppState listeners
 * are the two sources of open-handle warnings / hangs in Jest.
 */
let activeTree: Awaited<ReturnType<typeof render>> | null = null;
let rejectPendingMeasure: ((e: Error) => void) | null = null;

// ─── Render helper (wraps in act so effects flush before assertions) ──────────

async function renderComponent(ui: React.ReactElement) {
  const result = await render(ui);
  activeTree = result;
  return result;
}

// Press a button by label, wrapped in act so resulting state updates flush.
async function press(root: TestInst, label: string) {
  const btn = findPressable(root, label);
  if (!btn) throw new Error(`Button "${label}" not found`);
  await act(async () => {
    fireEvent.press(btn);
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
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();
});

// ─── Preview phase ────────────────────────────────────────────────────────────

describe("MeasurePartScreen – preview phase", () => {
  it("renders null when visible=false", async () => {
    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} visible={false} />
    );
    expect(result.toJSON()).toBeNull();
  });

  it('shows "Estimate dimensions" in the header', async () => {
    const result = await renderComponent(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(hasText(result.root!, "Estimate dimensions")).toBe(true);
  });

  it("shows manual dimension fields and confirmation", async () => {
    const result = await renderComponent(<MeasurePartScreen {...DEFAULT_PROPS} />);
    expect(hasText(result.root!, "You can also enter dimensions manually below.")).toBe(true);
    expect(hasText(result.root!, "Confirm dimensions")).toBe(true);
  });

});

// ─── Manual entry shortcut ────────────────────────────────────────────────────

describe("MeasurePartScreen – manual entry", () => {
  it("confirms directly from the editable preview fields", async () => {
    const onConfirm = jest.fn();
    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} onConfirm={onConfirm} />
    );
    await press(result.root!, "Confirm dimensions");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

// ─── onConfirm callback ───────────────────────────────────────────────────────

describe("MeasurePartScreen – onConfirm callback", () => {
  it("fires onConfirm with null values when fields are empty (manual entry)", async () => {
    const onConfirm = jest.fn();

    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} onConfirm={onConfirm} />
    );
    await press(result.root!, "Confirm dimensions");

    expect(onConfirm).toHaveBeenCalledWith<[PartDimensions]>({
      length: null,
      width: null,
      height: null,
      diameter: null,
    });
  });
});

// ─── AI photo-estimate endpoint routing ───────────────────────────────────────
//
// Verifies that handleCapture (initial capture) and handleCaptureOnConfirm
// (re-estimate from the confirm screen) both pick the correct API endpoint and
// Authorization header based on whether adminToken is present.
//
// Non-admin path  → /estimate-dimensions/search, no Authorization header
// Admin path      → /estimate-dimensions,        Authorization: Bearer <token>

describe("MeasurePartScreen – AI photo-estimate endpoint routing", () => {
  // Grab the stable takePictureAsync mock exposed by the expo-camera module mock.
  // This reference is valid for the lifetime of the test suite because jest.mock
  // is hoisted and the factory only runs once.
  const expoCamera = require("expo-camera") as {
    __mockTakePictureAsync: jest.Mock;
  };

  let mockFetch: jest.SpyInstance;

  beforeEach(() => {

    // The camera ref must be non-null for handleCapture to proceed; the
    // forwardRef CameraView mock handles that via useImperativeHandle.
    expoCamera.__mockTakePictureAsync.mockResolvedValue({
      base64: "fake-base64-data",
      uri: "file://fake-uri",
    });

    mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ length: 150, width: 80, height: 40, diameter: null }),
    } as Response);
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  // ── Initial capture (preview → estimating) ────────────────────────────────

  it("initial capture: non-admin fetches /estimate-dimensions/search without Authorization", async () => {
    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} adminToken="" />
    );

    await press(result.root!, "Capture & estimate");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/estimate-dimensions\/search$/);
    expect(
      (init.headers as Record<string, string>)["Authorization"]
    ).toBeUndefined();
  });

  it("initial capture: admin fetches /estimate-dimensions with Authorization header", async () => {
    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} adminToken="admin-token-xyz" />
    );

    await press(result.root!, "Capture & estimate");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/estimate-dimensions$/);
    expect(url).not.toMatch(/\/estimate-dimensions\/search/);
    expect(
      (init.headers as Record<string, string>)["Authorization"]
    ).toBe("Bearer admin-token-xyz");
  });

  // ── Re-estimate from confirm screen ──────────────────────────────────────

  it("re-estimate from confirm: non-admin fetches /estimate-dimensions/search without Authorization", async () => {
    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} adminToken="" />
    );

    await press(result.root!, "Capture & estimate");
    await flushPromises();
    expect(hasText(result.root!, "Review dimensions")).toBe(true);
    mockFetch.mockClear();

    await press(result.root!, "Estimate again");
    await press(result.root!, "Capture & estimate");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/estimate-dimensions\/search$/);
    expect(
      (init.headers as Record<string, string>)["Authorization"]
    ).toBeUndefined();
  });

  it("re-estimate from confirm: admin fetches /estimate-dimensions with Authorization header", async () => {
    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} adminToken="admin-token-xyz" />
    );

    await press(result.root!, "Capture & estimate");
    await flushPromises();
    expect(hasText(result.root!, "Review dimensions")).toBe(true);
    mockFetch.mockClear();

    await press(result.root!, "Estimate again");
    await press(result.root!, "Capture & estimate");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/estimate-dimensions$/);
    expect(url).not.toMatch(/\/estimate-dimensions\/search/);
    expect(
      (init.headers as Record<string, string>)["Authorization"]
    ).toBe("Bearer admin-token-xyz");
  });
});

// ─── AI photo-estimate error handling ─────────────────────────────────────────
//
// Verifies that handleCapture (initial capture) and handleCaptureOnConfirm
// (re-estimate from the confirm screen) surface errors correctly instead of
// leaving the screen silently stuck in the "estimating" phase.
//
// handleCapture errors  → Alert shown + phase returns to "preview"
// handleCaptureOnConfirm errors → inline confirmEstimateError shown

describe("MeasurePartScreen – AI photo-estimate error handling", () => {
  const expoCamera = require("expo-camera") as {
    __mockTakePictureAsync: jest.Mock;
  };

  let mockFetch: jest.SpyInstance;

  beforeEach(() => {

    expoCamera.__mockTakePictureAsync.mockResolvedValue({
      base64: "fake-base64-data",
      uri: "file://fake-uri",
    });
  });

  afterEach(() => {
    mockFetch?.mockRestore();
  });

  // ── handleCapture: non-OK HTTP response ───────────────────────────────────

  it("initial capture (non-admin): non-OK 500 shows Alert and returns to preview", async () => {
    mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Internal Server Error" }),
    } as Response);

    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} adminToken="" />
    );

    await press(result.root!, "Capture & estimate");
    await flushPromises();

    expect(mockAlert).toHaveBeenCalledWith(
      "Estimation failed",
      expect.stringContaining("Internal Server Error")
    );
    expect(hasText(result.root!, "Estimate dimensions")).toBe(true);
  });

  it("initial capture (admin): non-OK 500 shows Alert and returns to preview", async () => {
    mockFetch = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    } as Response);

    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} adminToken="admin-token-xyz" />
    );

    await press(result.root!, "Capture & estimate");
    await flushPromises();

    expect(mockAlert).toHaveBeenCalledWith(
      "Estimation failed",
      expect.stringContaining("Server error 500")
    );
    expect(hasText(result.root!, "Estimate dimensions")).toBe(true);
  });

  // ── handleCapture: network failure (fetch rejection) ──────────────────────

  it("initial capture (non-admin): network error shows Alert and returns to preview", async () => {
    mockFetch = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("Network request failed"));

    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} adminToken="" />
    );

    await press(result.root!, "Capture & estimate");
    await flushPromises();

    expect(mockAlert).toHaveBeenCalledWith(
      "Estimation failed",
      expect.stringContaining("Network request failed")
    );
    expect(hasText(result.root!, "Estimate dimensions")).toBe(true);
  });

  it("initial capture (admin): network error shows Alert and returns to preview", async () => {
    mockFetch = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("Network request failed"));

    const result = await renderComponent(
      <MeasurePartScreen {...DEFAULT_PROPS} adminToken="admin-token-xyz" />
    );

    await press(result.root!, "Capture & estimate");
    await flushPromises();

    expect(mockAlert).toHaveBeenCalledWith(
      "Estimation failed",
      expect.stringContaining("Network request failed")
    );
    expect(hasText(result.root!, "Estimate dimensions")).toBe(true);
  });

});

// ─── initialItem dimension seeding ───────────────────────────────────────────
//
// When the admin bridge "Measure Now" flow opens MeasurePartScreen it passes
// the InventoryItem as `initialItem` (not `initialDims`).  The component seeds
// the dimension input fields from initialItem.dimensions when no explicit
// initialDims is provided.  These tests verify that seeding path end-to-end.

describe("MeasurePartScreen – initialItem dimension seeding", () => {
  it("seeds the dimension fields from initialItem.dimensions when initialDims is null", async () => {

    const seedItem = {
      id: 99,
      catalog: "WIDGET-X",
      description: "Seeded from item",
      binLocations: [],
      dimensions: { length: 200, width: 100, height: 50, diameter: null },
    };

    const result = await renderComponent(
      <MeasurePartScreen
        {...DEFAULT_PROPS}
        initialDims={null}
        initialItem={seedItem as any}
      />
    );

    expect(findInputValues(result.root!)).toEqual(expect.arrayContaining(["200", "100", "50"]));
  });

  it("seeds the diameter field when initialItem.dimensions contains only a diameter", async () => {

    const seedItem = {
      id: 100,
      catalog: "PIPE-D",
      description: "Pipe with diameter",
      binLocations: [],
      dimensions: { length: null, width: null, height: null, diameter: 38 },
    };

    const result = await renderComponent(
      <MeasurePartScreen
        {...DEFAULT_PROPS}
        initialDims={null}
        initialItem={seedItem as any}
      />
    );

    expect(findInputValues(result.root!)).toContain("38");
  });

  it("prefers explicit initialDims over initialItem.dimensions when both are provided", async () => {

    const seedItem = {
      id: 101,
      catalog: "OVERRIDE-TEST",
      description: "Should be overridden",
      binLocations: [],
      dimensions: { length: 999, width: 888, height: 777, diameter: null },
    };

    const result = await renderComponent(
      <MeasurePartScreen
        {...DEFAULT_PROPS}
        initialDims={{ length: 200, width: 100, height: 50, diameter: null }}
        initialItem={seedItem as any}
      />
    );

    expect(findInputValues(result.root!)).toEqual(expect.arrayContaining(["200", "100", "50"]));
    expect(findInputValues(result.root!)).not.toContain("999");
  });

  it("leaves fields empty when both initialDims and initialItem.dimensions are null", async () => {

    const seedItem = {
      id: 102,
      catalog: "EMPTY-DIMS",
      description: "No dims",
      binLocations: [],
      dimensions: null,
    };

    const result = await renderComponent(
      <MeasurePartScreen
        {...DEFAULT_PROPS}
        initialDims={null}
        initialItem={seedItem as any}
      />
    );

    expect(hasText(result.root!, "Estimate dimensions")).toBe(true);
    expect(findInputValues(result.root!)).toEqual([]);
  });
});
