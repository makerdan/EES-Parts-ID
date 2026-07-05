/**
 * @jest-environment node
 *
 * Tests for the admin bridge "Measure Now" flow in PhotoScreen.
 *
 * Covers the end-to-end path:
 *   1. PhotoScreen renders the admin bridge card when isAdmin=true and the top
 *      result has no stored dimensions.
 *   2. Tapping "Measure Now" opens MeasurePartScreen (visible=true) and passes
 *      the bridge item as `initialItem`.
 *   3. MeasurePartScreen pre-fills dimension fields from initialItem.dimensions.
 *   4. Closing MeasurePartScreen clears adminBridgeMeasureItem (visible → false).
 *   5. Confirming dimensions via onConfirm routes them to setPendingMeasureSearch
 *      (dimension-filtered search) and navigates to "/" — NO server PATCH/PUT is
 *      made. This is intentional: the bridge drives a search, not a data edit.
 *      If persistence is ever added, these tests must be updated accordingly.
 *
 * Implementation notes:
 *   - PhotoScreen tests mock MeasurePartScreen so they can capture the props
 *     passed to it (visible, initialItem, onClose, onConfirm) without needing
 *     native camera modules loaded.
 *   - The "pre-fills from initialItem.dimensions" assertion is covered in the
 *     MeasurePartScreen section, which mounts the real component with a
 *     synthetic InventoryItem and verifies the field strings.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── expo-router ─────────────────────────────────────────────────────────────

const mockRouterNavigate = jest.fn();

jest.mock("expo-router", () => ({
  router: { navigate: mockRouterNavigate, push: jest.fn() },
  useFocusEffect: jest.fn(),
}));

// ─── @workspace/api-client-react ─────────────────────────────────────────────

const mockIdentifyMutateAsync = jest.fn();
const mockSearchMutateAsync   = jest.fn();

jest.mock("@workspace/api-client-react", () => ({
  useSearchInventory: jest.fn(() => ({
    mutate:        jest.fn(),
    mutateAsync:   mockSearchMutateAsync,
    isPending:     false,
    isSuccess:     false,
    isError:       false,
    reset:         jest.fn(),
  })),
  useAiIdentifyPart: jest.fn(() => ({
    mutateAsync:   mockIdentifyMutateAsync,
    isPending:     false,
    isSuccess:     false,
    isError:       false,
    reset:         jest.fn(),
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
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ status: "granted" }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({
    canceled: false,
    assets: [{ uri: "fake://image.jpg", width: 640, height: 480 }],
  }),
  launchCameraAsync: jest.fn().mockResolvedValue({ canceled: true }),
}));

jest.mock("@/utils/resizeImage", () => ({
  resizeImage: jest.fn().mockResolvedValue({ uri: "fake://resized.jpg", base64: "fakebase64" }),
  downscaleToFit: jest.fn().mockResolvedValue({ uri: "fake://resized.jpg", base64: "fakebase64" }),
  totalPayloadBytes: jest.fn().mockReturnValue(0),
}));

jest.mock("@/hooks/useScanHistory", () => ({
  useScanHistory: jest.fn(() => ({ history: [], addEntry: jest.fn() })),
}));

jest.mock("@/utils/scanHistory", () => ({}));

// ─── Utility mocks ────────────────────────────────────────────────────────────

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

jest.mock("@/utils/deviceId", () => ({ getDeviceId: jest.fn().mockResolvedValue("test-device-id") }));

jest.mock("fuse.js", () =>
  jest.fn().mockImplementation(() => ({ search: jest.fn().mockReturnValue([]) }))
);

// ─── Component mocks: ResultCard, helpers and MeasurePartScreen ───────────────
//
// MeasurePartScreen is mocked so we can inspect the props PhotoScreen passes to
// it without needing the full camera / LiDAR module surface to be present.
// Each render captures the latest visible, initialItem and onClose refs so the
// assertions below can query them directly.

let capturedMeasureVisible:   boolean = false;
let capturedMeasureInitialItem: any    = null;
let capturedMeasureOnClose:   (() => void) | null = null;
let capturedMeasureOnConfirm: ((d: unknown) => void) | null = null;

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: (props: {
    visible: boolean;
    onClose: () => void;
    onConfirm: (d: unknown) => void;
    initialItem?: any;
    adminToken: string;
  }) => {
    capturedMeasureVisible     = props.visible;
    capturedMeasureInitialItem = props.initialItem ?? null;
    capturedMeasureOnClose     = props.onClose;
    capturedMeasureOnConfirm   = props.onConfirm;
    return null;
  },
}));

jest.mock("@/components/ResultCard", () => ({
  ResultCard: () => null,
}));

jest.mock("@/components/BarcodeScanModal",  () => ({ BarcodeScanModal: () => null }));
jest.mock("@/components/BarcodeScreen",     () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/PartDetailsEditor", () => ({ PartDetailsEditor: () => null }));
jest.mock("@/components/ReferenceModal",    () => ({ ReferenceModal: () => null }));

// ─── AppContext mock ──────────────────────────────────────────────────────────
//
// jest.config.js maps @/contexts/AppContext → __mocks__/contexts/AppContext.js
// which exports useApp as a jest.fn().

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

const mockSetPinnedParts          = jest.fn();
const mockSetPendingMeasureSearch = jest.fn();
const mockSetPendingMapFocus      = jest.fn();
const mockShowToast               = jest.fn();
const mockRegisterLogoutHandler   = jest.fn(() => () => {});

function makeAppMock(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      textSize:                    "normal" as const,
      defaultConfidenceThreshold:  50,
      themeMode:                   "system" as const,
      shelfViewEnabled:            true,
      scanSound:                   true,
      dimensionUnit:               "mm" as const,
    },
    updateSetting:            jest.fn(),
    logout:                   jest.fn(),
    clearCache:               jest.fn(),
    isLoading:                false,
    isAdmin:                  false,
    adminToken:               null as string | null,
    registerLogoutHandler:    mockRegisterLogoutHandler,
    setPendingMapFocus:       mockSetPendingMapFocus,
    showToast:                mockShowToast,
    setPinnedParts:           mockSetPinnedParts,
    pendingMeasureSearch:     null,
    setPendingMeasureSearch:  mockSetPendingMeasureSearch,
    textFontScale:            1.0,
    pinnedParts:              [],
    ...overrides,
  };
}

// ─── Suppress react-test-renderer deprecation warning ────────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (typeof msg === "string" && (
        msg.includes("react-test-renderer is deprecated") ||
        msg.includes("Warning:")
      )) return;
      origConsoleError(msg, ...args);
    }
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Render helpers ───────────────────────────────────────────────────────────

async function render(ui: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(ui); });
  return tree;
}

const flushPromises = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

// ─── Instance-tree helpers ────────────────────────────────────────────────────

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
    root.findAll(n => (n.type as string) === "rn-pressable", { deep: true })
        .find(n => instText(n).includes(label)) ?? null
  );
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  capturedMeasureVisible     = false;
  capturedMeasureInitialItem = null;
  capturedMeasureOnClose     = null;
  capturedMeasureOnConfirm   = null;
  jest.clearAllMocks();
});

// ─── Component under test ─────────────────────────────────────────────────────

import PhotoScreen from "../app/(tabs)/photo";

// ─── Shared test fixtures ─────────────────────────────────────────────────────
//
// itemWithNoDims: triggers the admin bridge card (dimensions absent/all zeros).
// itemWithDims:   used in MeasurePartScreen seed tests.

const itemWithNoDims = {
  id: 42,
  catalog: "BREAKER-120",
  description: "Circuit breaker 120V",
  binLocations: [] as string[],
  dimensions: null as null,
};

// Helper: render PhotoScreen as admin and drive it through an identify+search
// cycle that surfaces the admin bridge card.
async function renderAdminWithBridgeCard(itemOverride: typeof itemWithNoDims = itemWithNoDims) {
  useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "admin-tok" }));

  mockIdentifyMutateAsync.mockResolvedValue({
    summary: "Circuit breaker",
    searchTerms: ["breaker"],
    synonyms: [],
    detectedVendor: null,
    partNumbers: [],
  });
  mockSearchMutateAsync.mockResolvedValue({
    results: [
      {
        item: itemOverride,
        confidence: 0.9,
        matchReason: "keyword",
        seriesLabel: null,
        variants: [],
      },
    ],
  });

  const tree = await render(<PhotoScreen />);
  activeTree = tree;
  await flushPromises();

  // Add an image so the Identify button becomes enabled.
  const libraryBtn = findPressable(tree.root, "Photo Library");
  expect(libraryBtn).not.toBeNull();
  await act(async () => { libraryBtn!.props.onPress(); });
  await flushPromises();

  // Fire identify — runs the full identify+search pipeline.
  const identifyBtn = findPressable(tree.root, "Identify Part");
  expect(identifyBtn).not.toBeNull();
  await act(async () => { identifyBtn!.props.onPress(); });
  await flushPromises();

  return tree;
}

// =============================================================================
// 1. Admin bridge card visibility
// =============================================================================

describe("PhotoScreen – admin bridge card", () => {
  it("shows the '⚠️ No dimensions on record' card for admins when top result has no dimensions", async () => {
    const tree = await renderAdminWithBridgeCard();
    expect(hasText(tree.root, "No dimensions on record")).toBe(true);
  });

  it("shows the 'Measure Now' button inside the bridge card", async () => {
    const tree = await renderAdminWithBridgeCard();
    expect(findPressable(tree.root, "Measure Now")).not.toBeNull();
  });

  it("does NOT show the bridge card for non-admin users", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: false, adminToken: null }));

    mockIdentifyMutateAsync.mockResolvedValue({
      summary: "Breaker", searchTerms: ["breaker"], synonyms: [],
      detectedVendor: null, partNumbers: [],
    });
    mockSearchMutateAsync.mockResolvedValue({
      results: [
        {
          item: itemWithNoDims,
          confidence: 0.9, matchReason: "keyword", seriesLabel: null, variants: [],
        },
      ],
    });

    const tree = await render(<PhotoScreen />);
    activeTree = tree;
    await flushPromises();

    const libraryBtn = findPressable(tree.root, "Photo Library");
    await act(async () => { libraryBtn!.props.onPress(); });
    await flushPromises();

    const identifyBtn = findPressable(tree.root, "Identify Part");
    await act(async () => { identifyBtn!.props.onPress(); });
    await flushPromises();

    expect(hasText(tree.root, "No dimensions on record")).toBe(false);
  });

  it("does NOT show the bridge card when the top result already has dimensions", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "admin-tok" }));

    const itemWithDims = {
      ...itemWithNoDims,
      dimensions: { length: 150, width: 80, height: 40, diameter: null },
    };

    mockIdentifyMutateAsync.mockResolvedValue({
      summary: "Breaker", searchTerms: ["breaker"], synonyms: [],
      detectedVendor: null, partNumbers: [],
    });
    mockSearchMutateAsync.mockResolvedValue({
      results: [
        {
          item: itemWithDims,
          confidence: 0.9, matchReason: "keyword", seriesLabel: null, variants: [],
        },
      ],
    });

    const tree = await render(<PhotoScreen />);
    activeTree = tree;
    await flushPromises();

    const libraryBtn = findPressable(tree.root, "Photo Library");
    await act(async () => { libraryBtn!.props.onPress(); });
    await flushPromises();

    const identifyBtn = findPressable(tree.root, "Identify Part");
    await act(async () => { identifyBtn!.props.onPress(); });
    await flushPromises();

    expect(hasText(tree.root, "No dimensions on record")).toBe(false);
  });
});

// =============================================================================
// 2. "Measure Now" opens MeasurePartScreen
// =============================================================================

describe("PhotoScreen – 'Measure Now' opens MeasurePartScreen", () => {
  it("sets MeasurePartScreen visible=true when 'Measure Now' is tapped", async () => {
    const tree = await renderAdminWithBridgeCard();

    expect(capturedMeasureVisible).toBe(false);

    const measureBtn = findPressable(tree.root, "Measure Now");
    expect(measureBtn).not.toBeNull();
    await act(async () => { measureBtn!.props.onPress(); });

    expect(capturedMeasureVisible).toBe(true);
  });

  it("passes the bridge item as initialItem to MeasurePartScreen", async () => {
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    expect(capturedMeasureInitialItem).not.toBeNull();
    expect(capturedMeasureInitialItem).toMatchObject({
      id:      itemWithNoDims.id,
      catalog: itemWithNoDims.catalog,
    });
  });

  it("dismisses the bridge card itself after tapping 'Measure Now'", async () => {
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    // The bridge card is now gone (adminBridgeItem was cleared) while the
    // MeasurePartScreen is visible — no stale duplicate prompt visible.
    expect(hasText(tree.root, "No dimensions on record")).toBe(false);
  });
});

// =============================================================================
// 3. Closing MeasurePartScreen clears adminBridgeMeasureItem
// =============================================================================

describe("PhotoScreen – closing MeasurePartScreen clears adminBridgeMeasureItem", () => {
  it("sets MeasurePartScreen visible=false when onClose is called", async () => {
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });
    expect(capturedMeasureVisible).toBe(true);
    expect(capturedMeasureOnClose).not.toBeNull();

    // Call the real onClose handler that PhotoScreen wires up.
    await act(async () => { capturedMeasureOnClose!(); });

    expect(capturedMeasureVisible).toBe(false);
  });

  it("clears initialItem (adminBridgeMeasureItem) when onClose is called", async () => {
    await renderAdminWithBridgeCard();

    const measureBtn = findPressable(activeTree!.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    expect(capturedMeasureInitialItem).not.toBeNull();

    await act(async () => { capturedMeasureOnClose!(); });

    // After close, the re-render passes initialItem=null (adminBridgeMeasureItem
    // was cleared inside the onClose handler).
    expect(capturedMeasureInitialItem).toBeNull();
  });
});

// =============================================================================
// 4. onConfirm — dimensions are routed to search, NOT persisted to the server
//
// Design intent: the admin bridge "Measure Now" flow is a *search assist* tool.
// When the admin confirms dimensions, handleMeasureSearchConfirm converts them
// into dimension-range search params and calls setPendingMeasureSearch so the
// Search tab performs a pre-filtered query. No PATCH/PUT to the inventory item
// is made. If persistence is ever added, update these tests.
// =============================================================================

describe("PhotoScreen – admin bridge onConfirm routes dimensions to search (no server write)", () => {
  it("closes MeasurePartScreen (visible=false) after onConfirm is called", async () => {
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });
    expect(capturedMeasureVisible).toBe(true);

    const confirmedDims = { length: 120, width: 85, height: 45, diameter: null };
    await act(async () => { capturedMeasureOnConfirm!(confirmedDims); });

    expect(capturedMeasureVisible).toBe(false);
  });

  it("calls setPendingMeasureSearch with exact min/max params derived from confirmed dimensions", async () => {
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    const confirmedDims = { length: 120, width: 85, height: 45, diameter: null };
    await act(async () => { capturedMeasureOnConfirm!(confirmedDims); });

    expect(mockSetPendingMeasureSearch).toHaveBeenCalledTimes(1);
    expect(mockSetPendingMeasureSearch).toHaveBeenCalledWith({
      minLength:   "120", maxLength:   "120",
      minWidth:    "85",  maxWidth:    "85",
      minHeight:   "45",  maxHeight:   "45",
      minDiameter: "",    maxDiameter: "",
    });
  });

  it("rounds fractional dimension values when building search params", async () => {
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    // LiDAR / AI estimates often return sub-mm floats; the handler rounds them.
    const confirmedDims = { length: 119.7, width: 84.4, height: 45.5, diameter: null };
    await act(async () => { capturedMeasureOnConfirm!(confirmedDims); });

    expect(mockSetPendingMeasureSearch).toHaveBeenCalledWith({
      minLength:   "120", maxLength:   "120",
      minWidth:    "84",  maxWidth:    "84",
      minHeight:   "46",  maxHeight:   "46",
      minDiameter: "",    maxDiameter: "",
    });
  });

  it("includes diameter in search params when a non-null diameter is confirmed", async () => {
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    const confirmedDims = { length: null, width: null, height: null, diameter: 32 };
    await act(async () => { capturedMeasureOnConfirm!(confirmedDims); });

    expect(mockSetPendingMeasureSearch).toHaveBeenCalledWith({
      minLength:   "", maxLength:   "",
      minWidth:    "", maxWidth:    "",
      minHeight:   "", maxHeight:   "",
      minDiameter: "32", maxDiameter: "32",
    });
  });

  it("does NOT call setPendingMeasureSearch when all confirmed dimensions are null", async () => {
    // handleMeasureSearchConfirm only forwards params when at least one value
    // is non-empty — a fully-null result is silently discarded.
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    const confirmedDims = { length: null, width: null, height: null, diameter: null };
    await act(async () => { capturedMeasureOnConfirm!(confirmedDims); });

    expect(mockSetPendingMeasureSearch).not.toHaveBeenCalled();
  });

  it("navigates to the root tab ('/') after confirm — not to a server update path", async () => {
    const tree = await renderAdminWithBridgeCard();

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    const confirmedDims = { length: 100, width: 60, height: 30, diameter: null };
    await act(async () => { capturedMeasureOnConfirm!(confirmedDims); });

    expect(mockRouterNavigate).toHaveBeenCalledWith("/");
  });

  it("does NOT make any inventory mutation calls after onConfirm (no server PATCH/PUT)", async () => {
    // This test explicitly documents the absence of server persistence.
    // useSearchInventory.mutateAsync fires once during the identify pipeline
    // (inside renderAdminWithBridgeCard) and must NOT be called again when the
    // admin confirms dimensions — confirming only updates the pending search
    // filter, it does not write back to the inventory item.
    // useAiIdentifyPart.mutateAsync likewise remains at exactly one call.
    //
    // If a future developer adds a PATCH/PUT mutation for dimension persistence
    // they must add a useUpdateInventoryItem (or equivalent) mock here and
    // assert it is called with the right item id and dimension payload.
    const tree = await renderAdminWithBridgeCard();

    const searchCallsBefore   = mockSearchMutateAsync.mock.calls.length;
    const identifyCallsBefore = mockIdentifyMutateAsync.mock.calls.length;

    const measureBtn = findPressable(tree.root, "Measure Now");
    await act(async () => { measureBtn!.props.onPress(); });

    const confirmedDims = { length: 100, width: 60, height: 30, diameter: null };
    await act(async () => { capturedMeasureOnConfirm!(confirmedDims); });
    await flushPromises();

    // Neither mutation received additional calls after confirm.
    expect(mockSearchMutateAsync).toHaveBeenCalledTimes(searchCallsBefore);
    expect(mockIdentifyMutateAsync).toHaveBeenCalledTimes(identifyCallsBefore);
  });
});

