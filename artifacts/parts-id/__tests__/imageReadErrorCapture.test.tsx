/**
 *
 * Tests that ImageReadError thrown by resizeImage during the photo-capture flow
 * surfaces as a visible error banner instead of producing a silent empty-result
 * screen.
 *
 * Scenario: the device hands back a URI that is stale (e.g. the camera temp
 * file was cleaned up before the app read it).  resizeImage wraps that failure
 * in ImageReadError.  pickImage must catch it and set inlineError so the user
 * sees a clear message — it must NOT silently proceed to the identify step and
 * leave the results pane blank.
 *
 * Covers:
 *   1. Library-pick path: ImageReadError → error banner shown.
 *   2. Camera-pick path:  ImageReadError → error banner shown.
 *   3. identifyMutation.mutateAsync is NOT called after a failed pick (no
 *      silent flow-through to empty AI results).
 *   4. Results list stays empty after a failed pick (no silent empty screen).
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── expo-router ─────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  router: { navigate: jest.fn(), push: jest.fn() },
  useFocusEffect: jest.fn(),
}));

// ─── @workspace/api-client-react ─────────────────────────────────────────────

const mockIdentifyMutateAsync = jest.fn();
const mockSearchMutateAsync   = jest.fn();

jest.mock("@workspace/api-client-react", () => ({
  useSearchInventory: jest.fn(() => ({
    mutate:      jest.fn(),
    mutateAsync: mockSearchMutateAsync,
    isPending:   false,
    isSuccess:   false,
    isError:     false,
    reset:       jest.fn(),
  })),
  useAiIdentifyPart: jest.fn(() => ({
    mutateAsync: mockIdentifyMutateAsync,
    isPending:   false,
    isSuccess:   false,
    isError:     false,
    reset:       jest.fn(),
  })),
  setAuthTokenGetter: jest.fn(),
  setBaseUrl:         jest.fn(),
  lookupByBarcode:    jest.fn(),
  aiIdentifyPart:     jest.fn(),
}));

// ─── @react-native-community/netinfo ─────────────────────────────────────────

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: true }),
  },
  NetInfoStateType: { unknown: "unknown", none: "none", wifi: "wifi", cellular: "cellular" },
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:     jest.fn().mockResolvedValue(null),
  setItem:     jest.fn().mockResolvedValue(undefined),
  removeItem:  jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── @/constants/colors ──────────────────────────────────────────────────────

jest.mock("@/constants/colors", () => ({
  __esModule: true,
  default: {
    light: {
      background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
      primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
      mutedForeground: "#64748b", destructive: "#ef4444",
      success: "#22c55e", warning: "#f59e0b",
    },
    dark: {
      background: "#000", foreground: "#fff", card: "#111", border: "#333",
      primary: "#3b82f6", primaryForeground: "#fff", muted: "#1e293b",
      mutedForeground: "#94a3b8", destructive: "#ef4444",
      success: "#22c55e", warning: "#f59e0b",
    },
    radius: 8,
  },
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ─── expo-image-picker ───────────────────────────────────────────────────────

jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync:      jest.fn().mockResolvedValue({ status: "granted" }),
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: "granted" }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///stale/image.jpg", width: 640, height: 480 }],
  }),
  launchCameraAsync: jest.fn().mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///stale/camera.jpg", width: 640, height: 480 }],
  }),
}));

// ─── @/utils/resizeImage — the focal mock for this test suite ─────────────────
//
// The default export resolves successfully. Individual tests that need to
// simulate ImageReadError call mockResizeImage.mockRejectedValueOnce(...).

const mockResizeImage = jest.fn().mockResolvedValue({
  uri: "fake://resized.jpg",
  base64: "fakebase64",
});

jest.mock("@/utils/resizeImage", () => {
  class ImageReadError extends Error {
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = "ImageReadError";
      if (cause !== undefined) this.cause = cause;
    }
  }
  return {
    resizeImage: mockResizeImage,
    downscaleToFit: jest.fn().mockResolvedValue({ uri: "fake://resized.jpg", base64: "fakebase64" }),
    totalPayloadBytes: jest.fn().mockReturnValue(0),
    ImageReadError,
  };
});

// ─── Retrieve the ImageReadError class from the (now-mocked) module ──────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ImageReadError } = require("@/utils/resizeImage") as {
  ImageReadError: new (message: string, cause?: unknown) => Error & { name: string };
};

// ─── Utility mocks ────────────────────────────────────────────────────────────

jest.mock("@/hooks/useScanHistory", () => ({
  useScanHistory: jest.fn(() => ({ history: [], addEntry: jest.fn() })),
}));
jest.mock("@/utils/scanHistory", () => ({}));
jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));
jest.mock("@/utils/storageErrorReporter", () => ({
  reportStorageError:     jest.fn(),
  setStorageErrorHandler: jest.fn(),
}));
jest.mock("@/utils/retryAsync", () => ({
  retryAsync: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock("@/utils/queryCacheBound", () => ({
  evictLRU:               jest.fn((c: unknown) => c),
  QUERY_CACHE_MAX_ENTRIES: 100,
}));
jest.mock("@/utils/offlineBarcode", () => ({
  FUSE_CACHE_KEY:           "fuse_cache",
  FUSE_CACHE_SYNCED_AT_KEY: "fuse_synced_at",
  getFuseCacheSyncedAt:     jest.fn().mockResolvedValue(Date.now()),
  FUSE_SYNC_MAX_AGE_MS:     Infinity,
  lookupByBarcodeOffline:   jest.fn().mockResolvedValue(null),
}));
jest.mock("@/utils/searchHelpers", () => ({
  QUERY_CACHE_KEY:          "query_cache",
  buildQueryKey:            jest.fn().mockReturnValue("test-key"),
  buildSearchBody:          jest.fn().mockReturnValue({ keywords: "", confidenceThreshold: 50 }),
  pruneExpired:             jest.fn((c: unknown) => c),
  formatStaleCacheWarning:  jest.fn().mockReturnValue(""),
  formatRelativeAge:        jest.fn().mockReturnValue("1 hour ago"),
  resolveOfflineFallback:   jest.fn().mockReturnValue({ results: [], cacheType: null }),
  fetchInventoryPages:      jest.fn().mockResolvedValue([]),
}));
jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));
jest.mock("@/utils/deviceId", () => ({
  getDeviceId: jest.fn().mockResolvedValue("test-device-id"),
}));
jest.mock("fuse.js", () =>
  jest.fn().mockImplementation(() => ({ search: jest.fn().mockReturnValue([]) }))
);

// ─── Component stubs ─────────────────────────────────────────────────────────

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));
jest.mock("@/components/ResultCard",        () => ({ ResultCard: () => null }));
jest.mock("@/components/BarcodeScanModal",  () => ({ BarcodeScanModal: () => null }));
jest.mock("@/components/BarcodeScreen",     () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/PartDetailsEditor", () => ({ PartDetailsEditor: () => null }));
jest.mock("@/components/ReferenceModal",    () => ({ ReferenceModal: () => null }));

// ─── AppContext mock ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

const mockSetPinnedParts         = jest.fn();
const mockSetPendingMeasureSearch = jest.fn();
const mockSetPendingMapFocus      = jest.fn();
const mockShowToast               = jest.fn();
const mockRegisterLogoutHandler   = jest.fn(() => () => {});

function makeAppMock(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      textSize:                   "normal" as const,
      defaultConfidenceThreshold: 50,
      themeMode:                  "system" as const,
      shelfViewEnabled:           true,
      scanSound:                  true,
      dimensionUnit:              "mm" as const,
    },
    updateSetting:           jest.fn(),
    logout:                  jest.fn(),
    clearCache:              jest.fn(),
    isLoading:               false,
    isAdmin:                 false,
    adminToken:              null as string | null,
    registerLogoutHandler:   mockRegisterLogoutHandler,
    setPendingMapFocus:      mockSetPendingMapFocus,
    showToast:               mockShowToast,
    setPinnedParts:          mockSetPinnedParts,
    pendingMeasureSearch:    null,
    setPendingMeasureSearch: mockSetPendingMeasureSearch,
    textFontScale:           1.0,
    pinnedParts:             [],
    ...overrides,
  };
}

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import PhotoScreen from "../app/(tabs)/photo";

// ─── Render / flush helpers ───────────────────────────────────────────────────

async function renderScreen(ui: React.ReactElement) {
  const result = await render(ui);
  return result;
}

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

// ─── Instance-tree helpers ────────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((c: Inst | string) => instText(c as Inst | string)).join("");
}

function hasText(root: TestInstance, text: string): boolean {
  return instText(root as unknown as Inst).includes(text);
}

function findPressable(root: TestInstance, label: string): Inst | null {
  return (
    root
      .queryAll((n: TestInstance) => (n.type as string) === "rn-pressable", { includeSelf: true })
      .find((n: Inst) => instText(n).includes(label)) ?? null
  );
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();
  // Restore default resizeImage mock (resolves successfully) after each test.
  mockResizeImage.mockResolvedValue({
    uri: "fake://resized.jpg",
    base64: "fakebase64",
  });
});

// ─── Shared setup ─────────────────────────────────────────────────────────────

function setupApp() {
  useApp.mockReturnValue(makeAppMock());
}

// =============================================================================
// 1. Library-pick path — ImageReadError bubbles up to the error banner
// =============================================================================

describe("PhotoScreen – ImageReadError during library pick", () => {
  it("shows the error banner when resizeImage throws ImageReadError for a stale URI", async () => {
    setupApp();

    const staleError = new ImageReadError(
      "Could not read the image file — it may be corrupt, deleted, or inaccessible.",
      new Error("ENOENT: no such file or directory")
    );
    mockResizeImage.mockRejectedValueOnce(staleError);

    const result = await renderScreen(<PhotoScreen />);
    activeTree = result;

    const libraryBtn = findPressable(result.root!, "Photo Library");
    expect(libraryBtn).not.toBeNull();

    await act(async () => { fireEvent.press(libraryBtn!); });
    await flushPromises();

    expect(hasText(result.root!, "Could not process the selected photo")).toBe(true);
  });

  it("shows the ⚠ prefix on the error banner", async () => {
    setupApp();

    mockResizeImage.mockRejectedValueOnce(
      new ImageReadError("Could not read the image file — it may be corrupt, deleted, or inaccessible.")
    );

    const result = await renderScreen(<PhotoScreen />);
    activeTree = result;

    const libraryBtn = findPressable(result.root!, "Photo Library");
    await act(async () => { fireEvent.press(libraryBtn!); });
    await flushPromises();

    expect(hasText(result.root!, "⚠")).toBe(true);
  });
});

// =============================================================================
// 2. Camera-pick path — ImageReadError bubbles up to the error banner
// =============================================================================

describe("PhotoScreen – ImageReadError during camera pick", () => {
  it("shows the error banner when resizeImage throws ImageReadError for a stale camera URI", async () => {
    setupApp();

    mockResizeImage.mockRejectedValueOnce(
      new ImageReadError(
        "Could not read the image file — it may be corrupt, deleted, or inaccessible.",
        new Error("File system permission denied")
      )
    );

    const result = await renderScreen(<PhotoScreen />);
    activeTree = result;

    const cameraBtn = findPressable(result.root!, "Camera");
    expect(cameraBtn).not.toBeNull();

    await act(async () => { fireEvent.press(cameraBtn!); });
    await flushPromises();

    expect(hasText(result.root!, "Could not process the selected photo")).toBe(true);
  });
});

// =============================================================================
// 3. No silent flow-through — identifyMutation.mutateAsync must NOT be called
// =============================================================================

describe("PhotoScreen – no silent AI identify after ImageReadError", () => {
  it("does NOT call identifyMutation.mutateAsync when resizeImage throws ImageReadError", async () => {
    setupApp();

    mockResizeImage.mockRejectedValueOnce(
      new ImageReadError(
        "Could not process the image — it may be corrupt, in an unsupported format, or the URI is stale."
      )
    );

    const result = await renderScreen(<PhotoScreen />);
    activeTree = result;

    const libraryBtn = findPressable(result.root!, "Photo Library");
    await act(async () => { fireEvent.press(libraryBtn!); });
    await flushPromises();

    // The failed pick must not have triggered identification — there is nothing
    // to identify when image loading itself failed.
    expect(mockIdentifyMutateAsync).not.toHaveBeenCalled();
  });

  it("does NOT call searchMutation.mutateAsync when resizeImage throws ImageReadError", async () => {
    setupApp();

    mockResizeImage.mockRejectedValueOnce(
      new ImageReadError(
        "Could not process the image — it may be corrupt, in an unsupported format, or the URI is stale."
      )
    );

    const result = await renderScreen(<PhotoScreen />);
    activeTree = result;

    const libraryBtn = findPressable(result.root!, "Photo Library");
    await act(async () => { fireEvent.press(libraryBtn!); });
    await flushPromises();

    expect(mockSearchMutateAsync).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 4. Results list remains empty — no silent empty-result screen
// =============================================================================

describe("PhotoScreen – results list empty after ImageReadError", () => {
  it("shows no result cards after a failed library pick (empty screen, not silent blank)", async () => {
    setupApp();

    mockResizeImage.mockRejectedValueOnce(
      new ImageReadError(
        "Could not read the image file — it may be corrupt, deleted, or inaccessible."
      )
    );

    const result = await renderScreen(<PhotoScreen />);
    activeTree = result;

    const libraryBtn = findPressable(result.root!, "Photo Library");
    await act(async () => { fireEvent.press(libraryBtn!); });
    await flushPromises();

    // The error banner is present — the user is never left staring at a blank
    // results area with no explanation.
    expect(hasText(result.root!, "Could not process the selected photo")).toBe(true);

    // No ResultCard instances should be rendered (nothing was identified).
    const resultCards = result.root!.queryAll(
      (n: TestInstance) => (n.type as unknown) === "ResultCard" || instText(n).includes("confidence"),
      { includeSelf: true }
    );
    expect(resultCards).toHaveLength(0);
  });
});
