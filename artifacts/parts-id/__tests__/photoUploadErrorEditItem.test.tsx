/**
 * @jest-environment node
 *
 * Verifies that photo-upload errors in EditItemScreen surface as visible
 * error banner text after the expo-file-system import was changed to
 * expo-file-system/legacy.
 *
 * Scenarios covered:
 *   1. FileSystem.readAsStringAsync (expo-file-system/legacy) throws →
 *      errorMsg banner shown ("Could not save changes. Check connection and try again."
 *      for generic errors, or the verbatim message for named errors)
 *   2. PATCH /photo returns a non-ok response → errorMsg banner shown
 *   3. Happy path: readAsStringAsync succeeds + PATCH ok →
 *      fetch called with correct imageBase64 body, no error banner
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── expo-file-system/legacy mock ────────────────────────────────────────────

const mockReadAsStringAsync = jest.fn<Promise<string>, [string, { encoding: string }]>();

jest.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: (...a: [string, { encoding: string }]) => mockReadAsStringAsync(...a),
  EncodingType: { Base64: "base64" },
}));

// ─── PartPhotoPicker mock — captures onChange per slot ────────────────────────

const mockPhotoCbs: {
  slot1?: (uri: string | null) => void;
  slot2?: (uri: string | null) => void;
} = {};

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: ({
    onChange,
    slot,
  }: {
    onChange: (uri: string | null) => void;
    slot?: number;
  }) => {
    if (slot === 2) {
      mockPhotoCbs.slot2 = onChange;
    } else {
      mockPhotoCbs.slot1 = onChange;
    }
    return null;
  },
}));

// ─── fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

// ─── AppContext mock ──────────────────────────────────────────────────────────

const mockUseApp = jest.fn();

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockUseApp(),
}));

// ─── expo-router mock ─────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  useRouter:            jest.fn(() => ({ replace: jest.fn(), back: jest.fn() })),
  useLocalSearchParams: jest.fn(() => ({})),
  useFocusEffect:       jest.fn(),
}));

// ─── Other module mocks ───────────────────────────────────────────────────────

jest.mock("expo-camera", () => ({
  CameraView:           () => null,
  useCameraPermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
}));

jest.mock("lidar-measure", () => ({
  isLiDARSupported: jest.fn(() => false),
}));

jest.mock("@workspace/api-client-react", () => ({
  useUpdateItemBins:        jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  useUpdateItemBarcodes:    jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  useUpdateItemKeywords:    jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  getListInventoryQueryKey: jest.fn(() => ["inventory"]),
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    getQueriesData:    jest.fn().mockReturnValue([]),
    setQueryData:      jest.fn(),
    setQueriesData:    jest.fn(),
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:     jest.fn().mockResolvedValue(null),
    setItem:     jest.fn().mockResolvedValue(undefined),
    removeItem:  jest.fn().mockResolvedValue(undefined),
    multiRemove: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

jest.mock("@/utils/editItemCache", () => ({
  invalidateListCache:           jest.fn().mockResolvedValue(undefined),
  evictDeletedItemFromAllCaches: jest.fn().mockResolvedValue(undefined),
  invalidateAllCachesAfterSave:  jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

jest.mock("@/components/KeyboardDoneInput", () => {
  const Rct = require("react");
  return {
    KeyboardDoneInput: (props: {
      placeholder?: string;
      value?: string;
      testID?: string;
      [k: string]: unknown;
    }) =>
      Rct.createElement("rn-textinput", {
        testID:       props.testID ?? props.placeholder ?? "",
        value:        props.value,
        placeholder:  props.placeholder,
      }),
  };
});

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

jest.mock("@/utils/adminGuard", () => ({
  shouldRedirectNonAdmin: jest.fn(() => false),
}));

// ─── Suppress react-test-renderer deprecation warnings ───────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") ||
          msg.includes("Warning:"))
      ) return;
      origConsoleError(msg, ...args);
    }
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import React from "react";
import renderer, { act } from "react-test-renderer";
import type { InventoryItem } from "@workspace/api-client-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = renderer.ReactTestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(c => instText(c as Inst | string)).join("");
}

function hasText(root: Inst, text: string): boolean {
  return instText(root).includes(text);
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .findAll(n => (n.type as string) === "rn-pressable", { deep: true })
      .find(n => instText(n).includes(label)) ?? null
  );
}

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 99,
    catalog: "EDIT-TEST",
    description: "Edit item test part",
    vendor: "ACME",
    binLocations: [],
    aiKeywords: [],
    imageUrl: null,
    imageUrl2: null,
    ...overrides,
  } as unknown as InventoryItem;
}

function makeAppContext(overrides: Record<string, unknown> = {}) {
  return {
    isLoading:           true,   // keeps shouldRedirectNonAdmin guard silent
    isAdmin:             true,
    adminToken:          "test-admin-token",
    pendingLidarDims:    null,
    setPendingLidarDims: jest.fn(),
    settings:            {},
    logout:              jest.fn(),
    ...overrides,
  };
}

// Lazy-import the screen so all module mocks are in place first.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const getEditItemScreen = () =>
  require("@/app/edit-item").default as React.ComponentType;

async function renderScreen(item: InventoryItem) {
  const { useLocalSearchParams } = require("expo-router") as {
    useLocalSearchParams: jest.Mock;
  };
  useLocalSearchParams.mockReturnValue({ item: JSON.stringify(item) });

  jest.resetModules();
  const EditItemScreen = getEditItemScreen();
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<EditItemScreen />); });
  return tree;
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  jest.clearAllMocks();
  mockPhotoCbs.slot1 = undefined;
  mockPhotoCbs.slot2 = undefined;
  // Restore safe defaults after clearAllMocks.
  mockFetch.mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ imageUrl: "https://example.com/photo.jpg" }),
  });
  mockReadAsStringAsync.mockResolvedValue("base64data==");
  mockUseApp.mockReturnValue(makeAppContext());
});

beforeEach(() => {
  mockUseApp.mockReturnValue(makeAppContext());
});

// =============================================================================
// 1. readAsStringAsync throws → errorMsg banner shown
// =============================================================================

describe("EditItemScreen – FileSystem.readAsStringAsync failure surfaces as error banner", () => {
  it("shows an error banner when readAsStringAsync throws during photo save", async () => {
    mockReadAsStringAsync.mockRejectedValueOnce(new Error("disk read failed"));

    const item = makeItem();
    // Set up params before rendering.
    const { useLocalSearchParams } = require("expo-router") as {
      useLocalSearchParams: jest.Mock;
    };
    useLocalSearchParams.mockReturnValue({ item: JSON.stringify(item) });

    const EditItemScreen = getEditItemScreen();
    const tree = await (async () => {
      let t!: renderer.ReactTestRenderer;
      await act(async () => { t = renderer.create(<EditItemScreen />); });
      return t;
    })();
    activeTree = tree;

    // Trigger slot-1 photo picker onChange with a new URI.
    expect(mockPhotoCbs.slot1).toBeDefined();
    await act(async () => {
      mockPhotoCbs.slot1!("file:///new/photo.jpg");
    });

    // The Save Details button should now be enabled (hasChanges = true).
    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    // An error banner or inline field error must be visible.
    expect(
      hasText(tree.root, "disk read failed") ||
      hasText(tree.root, "check connection") ||
      hasText(tree.root, "Photo 1 failed")
    ).toBe(true);
  });

  it("shows error banner (not a blank screen) when readAsStringAsync throws during slot-2 photo save", async () => {
    mockReadAsStringAsync.mockRejectedValueOnce(new Error("slot 2 disk error"));

    const item = makeItem();
    const { useLocalSearchParams } = require("expo-router") as {
      useLocalSearchParams: jest.Mock;
    };
    useLocalSearchParams.mockReturnValue({ item: JSON.stringify(item) });

    const EditItemScreen = getEditItemScreen();
    const tree = await (async () => {
      let t!: renderer.ReactTestRenderer;
      await act(async () => { t = renderer.create(<EditItemScreen />); });
      return t;
    })();
    activeTree = tree;

    expect(mockPhotoCbs.slot2).toBeDefined();
    await act(async () => {
      mockPhotoCbs.slot2!("file:///new/photo2.jpg");
    });

    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(
      hasText(tree.root, "slot 2 disk error") ||
      hasText(tree.root, "check connection") ||
      hasText(tree.root, "Photo 2 failed")
    ).toBe(true);
  });
});

// =============================================================================
// 2. PATCH /photo non-ok → errorMsg banner shown
// =============================================================================

describe("EditItemScreen – PATCH /photo non-ok response surfaces as error banner", () => {
  it("shows an error banner when the server returns a 400 for the photo upload", async () => {
    mockReadAsStringAsync.mockResolvedValue("base64data==");
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: jest.fn().mockResolvedValue({ error: "Unsupported image format" }),
    });

    const item = makeItem();
    const { useLocalSearchParams } = require("expo-router") as {
      useLocalSearchParams: jest.Mock;
    };
    useLocalSearchParams.mockReturnValue({ item: JSON.stringify(item) });

    const EditItemScreen = getEditItemScreen();
    const tree = await (async () => {
      let t!: renderer.ReactTestRenderer;
      await act(async () => { t = renderer.create(<EditItemScreen />); });
      return t;
    })();
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!("file:///new/photo.jpg"); });

    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    // The specific error message from the server or generic fallback must appear.
    expect(
      hasText(tree.root, "Unsupported image format") ||
      hasText(tree.root, "check connection") ||
      hasText(tree.root, "Photo 1 failed")
    ).toBe(true);
  });

  it("shows the session-expired message when the server returns a 401 for the photo upload", async () => {
    mockReadAsStringAsync.mockResolvedValue("base64data==");
    // Return empty json so the thrown message falls back to "HTTP 401",
    // which the handler detects via msg.includes("401").
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({}),
    });

    const item = makeItem();
    const { useLocalSearchParams } = require("expo-router") as {
      useLocalSearchParams: jest.Mock;
    };
    useLocalSearchParams.mockReturnValue({ item: JSON.stringify(item) });

    const EditItemScreen = getEditItemScreen();
    const tree = await (async () => {
      let t!: renderer.ReactTestRenderer;
      await act(async () => { t = renderer.create(<EditItemScreen />); });
      return t;
    })();
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!("file:///new/photo.jpg"); });

    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(hasText(tree.root, "Admin session expired")).toBe(true);
  });
});

// =============================================================================
// 3. Happy path: readAsStringAsync + PATCH succeed → fetch called with imageBase64
// =============================================================================

describe("EditItemScreen – successful photo upload calls PATCH /photo with imageBase64", () => {
  it("calls fetch with imageBase64 body and slot=1 when slot-1 photo is changed", async () => {
    const fakeBase64 = "ZmFrZWJhc2U2NA==";
    mockReadAsStringAsync.mockResolvedValue(fakeBase64);
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ imageUrl: "https://example.com/photo.jpg" }),
    });

    const item = makeItem();
    const { useLocalSearchParams } = require("expo-router") as {
      useLocalSearchParams: jest.Mock;
    };
    useLocalSearchParams.mockReturnValue({ item: JSON.stringify(item) });

    const EditItemScreen = getEditItemScreen();
    const tree = await (async () => {
      let t!: renderer.ReactTestRenderer;
      await act(async () => { t = renderer.create(<EditItemScreen />); });
      return t;
    })();
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!("file:///new/photo.jpg"); });
    const saveBtn = findPressable(tree.root, "Save Details");

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/photo"),
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining(fakeBase64),
      }),
    );

    // No error banner shown after a successful upload.
    expect(
      hasText(tree.root, "Could not save changes") ||
      hasText(tree.root, "Admin session expired")
    ).toBe(false);
  });

  it("reads the photo URI from expo-file-system/legacy with base64 encoding", async () => {
    const photoUri = "file:///tmp/upload-test.jpg";
    mockReadAsStringAsync.mockResolvedValue("aGVsbG8=");
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ imageUrl: "https://example.com/photo.jpg" }),
    });

    const item = makeItem();
    const { useLocalSearchParams } = require("expo-router") as {
      useLocalSearchParams: jest.Mock;
    };
    useLocalSearchParams.mockReturnValue({ item: JSON.stringify(item) });

    const EditItemScreen = getEditItemScreen();
    const tree = await (async () => {
      let t!: renderer.ReactTestRenderer;
      await act(async () => { t = renderer.create(<EditItemScreen />); });
      return t;
    })();
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!(photoUri); });
    const saveBtn = findPressable(tree.root, "Save Details");

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(mockReadAsStringAsync).toHaveBeenCalledWith(
      photoUri,
      expect.objectContaining({ encoding: "base64" }),
    );
  });
});
