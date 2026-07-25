/**
 * @jest-environment node
 *
 * Component-level tests for the map-pin and Measure-to-Search cross-tab flows.
 *
 * Exercises the real callbacks and effects inside SearchScreen (index.tsx) and
 * PhotoScreen (photo.tsx) by rendering the actual components with mocked
 * dependencies, then calling or intercepting the live handlers.
 *
 * Covered:
 *
 *  1. SearchScreen – handleShowOnMap: calls setPinnedParts with correct aisleNums
 *     parsed from bin codes and navigates to the map tab.
 *
 *  2. SearchScreen – useFocusEffect: consuming pendingMeasureSearch clears the
 *     pending value, sets keywords to the measure string, and fires
 *     searchMutation.mutate inside a 0ms setTimeout.
 *
 *  3. PhotoScreen – mapPromptBins: after identify+search returns a binned top
 *     result, setPinnedParts is called and the "Part pinned on map" banner
 *     appears in the rendered tree.
 *
 *  4. PhotoScreen – MeasurePartScreen integration: the admin onConfirm callback
 *     builds a dimension string (e.g. "200mm 100mm 50mm") and calls
 *     setPendingMeasureSearch with it before navigating to "/".
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";
import { makeAppMock, flushPromises as rawFlush } from "./helpers/appMocks";

// ─── expo-router: capture useFocusEffect callback and router calls ────────────

const mockRouterNavigate = jest.fn();
const mockRouterPush    = jest.fn();
let capturedFocusEffect: (() => void) | null = null;

jest.mock("expo-router", () => ({
  router: { navigate: mockRouterNavigate, push: mockRouterPush },
  useFocusEffect: (cb: () => void) => {
    // Store the latest callback so tests can trigger it directly.
    capturedFocusEffect = cb;
  },
}));

// ─── @workspace/api-client-react ─────────────────────────────────────────────

const mockSearchMutate      = jest.fn();
const mockSearchMutateAsync = jest.fn();
const mockIdentifyMutateAsync = jest.fn();

jest.mock("@workspace/api-client-react", () => ({
  useSearchInventory: jest.fn(() => ({
    mutate:       mockSearchMutate,
    mutateAsync:  mockSearchMutateAsync,
    isPending:    false,
    isSuccess:    true,
    isError:      false,
    data: {
      results: [
        {
          item: {
            id: 1,
            catalog: "WIDGET-A",
            binLocations: ["05-02-001"],
            description: "Test widget",
            dimensions: null,
          },
          confidence: 0.9,
          matchReason: "keyword",
          seriesLabel: null,
          variants: [],
        },
      ],
      belowThreshold:    0,
      dimensionCounts:   undefined,
      sizeUnknownResults: [],
    },
    reset: jest.fn(),
  })),
  useAiIdentifyPart: jest.fn(() => ({
    mutateAsync:  mockIdentifyMutateAsync,
    isPending:    false,
    isSuccess:    false,
    isError:      false,
    reset:        jest.fn(),
  })),
  setAuthTokenGetter: jest.fn(),
  setBaseUrl:         jest.fn(),
  lookupByBarcode:    jest.fn(),
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

// ─── fuse.js ─────────────────────────────────────────────────────────────────

jest.mock("fuse.js", () =>
  jest.fn().mockImplementation(() => ({ search: jest.fn().mockReturnValue([]) }))
);

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── @/components – ResultCard captures onShowOnMap; MeasurePartScreen captures onConfirm ──

let capturedOnShowOnMap:   ((item: any) => void) | null = null;
let capturedMeasureConfirm: ((dims: any) => void) | null = null;

jest.mock("@/components/ResultCard", () => ({
  ResultCard: ({ onShowOnMap }: any) => {
    capturedOnShowOnMap = onShowOnMap;
    return null;
  },
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: ({ onConfirm }: any) => {
    capturedMeasureConfirm = onConfirm;
    return null;
  },
}));

jest.mock("@/components/FilterPanel",       () => ({ FilterPanel: () => null, ConfidenceSlider: () => null }));
jest.mock("@/components/ReferenceModal",    () => ({ ReferenceModal: () => null }));
jest.mock("@/components/PartDetailsEditor", () => ({ PartDetailsEditor: () => null }));
jest.mock("@/components/BrowseByAisle",     () => ({ BrowseByAisle: () => null }));
jest.mock("@/components/BrowseByCategory",  () => ({ BrowseByCategory: () => null }));
jest.mock("@/components/BarcodeScanModal",  () => ({ BarcodeScanModal: () => null }));
jest.mock("@/components/BarcodeScreen",     () => ({ __esModule: true, default: () => null }));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

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

// ─── Utility mocks ────────────────────────────────────────────────────────────

jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));

jest.mock("@/utils/storageErrorReporter", () => ({
  reportStorageError:    jest.fn(),
  setStorageErrorHandler: jest.fn(),
}));

jest.mock("@/utils/retryAsync", () => ({
  retryAsync: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock("@/utils/queryCacheBound", () => ({
  evictLRU:              jest.fn((c: unknown) => c),
  QUERY_CACHE_MAX_ENTRIES: 100,
}));

jest.mock("@/utils/offlineBarcode", () => ({
  FUSE_CACHE_KEY:         "fuse_cache",
  FUSE_CACHE_SYNCED_AT_KEY: "fuse_synced_at",
  getFuseCacheSyncedAt:   jest.fn().mockResolvedValue(Date.now()),
  FUSE_SYNC_MAX_AGE_MS:   Infinity,
  lookupByBarcodeOffline: jest.fn().mockResolvedValue(null),
  replaceBarcodeCacheWithServerItems: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/searchHelpers", () => ({
  QUERY_CACHE_KEY:         "query_cache",
  buildQueryKey:           jest.fn().mockReturnValue("test-key"),
  buildSearchBody:         jest.fn().mockReturnValue({ keywords: "", confidenceThreshold: 50 }),
  pruneExpired:            jest.fn((c: unknown) => c),
  formatStaleCacheWarning: jest.fn().mockReturnValue(""),
  formatRelativeAge:       jest.fn().mockReturnValue("1 hour ago"),
  resolveOfflineFallback:  jest.fn().mockReturnValue({ results: [], cacheType: null }),
  fetchInventoryPages:     jest.fn().mockResolvedValue([]),
}));

jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));

jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001" }));

// ─── react-native-reanimated (needed by WarehouseMapView) ─────────────────────

jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());

// ─── react-native-gesture-handler (needed by WarehouseMapView) ───────────────

jest.mock("react-native-gesture-handler", () => require("./helpers/mapMocks").createGestureHandlerMock());

// ─── react-native-svg (needed by WarehouseMapView) ───────────────────────────

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── expo-asset (needed by WarehouseMapView) ──────────────────────────────────

jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());

// ─── @/utils/floorPlanCache (needed by WarehouseMapView) ─────────────────────

jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

// ─── @/utils/mapViewport (needed by WarehouseMapView) ────────────────────────

jest.mock("@/utils/mapViewport", () => require("./helpers/mapMocks").createMapViewportMock());

// ─── PhotoScreen-specific mocks ───────────────────────────────────────────────

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

// ─── AppContext: override the file-level mock per-test ────────────────────────
// jest.config.js maps @/contexts/AppContext → __mocks__/contexts/AppContext.js
// which exports useApp as a jest.fn(). We import it and call mockReturnValue.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

const mockSetPinnedParts         = jest.fn();
const mockSetPendingMeasureSearch = jest.fn();
const mockShowToast              = jest.fn();
const mockSetPendingMapFocus     = jest.fn();
const mockRegisterLogoutHandler  = jest.fn(() => () => {});

function makeTestAppMock(overrides: Record<string, unknown> = {}) {
  return makeAppMock({
    registerLogoutHandler:   mockRegisterLogoutHandler,
    setPendingMapFocus:      mockSetPendingMapFocus,
    showToast:               mockShowToast,
    setPinnedParts:          mockSetPinnedParts,
    setPendingMeasureSearch: mockSetPendingMeasureSearch,
    ...overrides,
  });
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

const flushPromises = () => act(async () => { await rawFlush(); });

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
  capturedOnShowOnMap    = null;
  capturedMeasureConfirm = null;
  capturedFocusEffect    = null;
  jest.clearAllMocks();
});

// ─── Components under test ────────────────────────────────────────────────────

import SearchScreen from "../app/(tabs)/index";
import PhotoScreen  from "../app/(tabs)/photo";
import { WarehouseMapView } from "../components/WarehouseMapView";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function renderSearch(appOverrides: Record<string, unknown> = {}) {
  useApp.mockReturnValue(makeTestAppMock(appOverrides));
  const tree = await render(<SearchScreen />);
  activeTree = tree;
  await flushPromises();
  return tree;
}

async function renderPhoto(appOverrides: Record<string, unknown> = {}) {
  useApp.mockReturnValue(makeTestAppMock(appOverrides));
  const tree = await render(<PhotoScreen />);
  activeTree = tree;
  await flushPromises();
  return tree;
}

// =============================================================================
// 1. SearchScreen – handleShowOnMap
//    The real callback is extracted from the component via the ResultCard mock.
// =============================================================================

describe("SearchScreen – handleShowOnMap calls setPinnedParts", () => {
  it("pins a single bin with the correct aisleNum and navigates to the map tab", async () => {
    await renderSearch();

    // ResultCard was rendered by the patched FlatList; its onShowOnMap is captured.
    expect(capturedOnShowOnMap).not.toBeNull();

    const item = { id: 1, catalog: "WIDGET-A", binLocations: ["05-02-001"], description: "" };

    await act(async () => { capturedOnShowOnMap!(item); });

    expect(mockSetPinnedParts).toHaveBeenCalledWith([
      { binCode: "05-02-001", label: "WIDGET-A", aisleNum: 5, partId: 1, sizeLabel: "—" },
    ]);
    expect(mockRouterNavigate).toHaveBeenCalledWith("/(tabs)/map");
  });

  it("builds one pin per parseable bin, each with the correct aisleNum", async () => {
    await renderSearch();

    const item = {
      id: 2, catalog: "MULTI-BIN",
      binLocations: ["03-01-010", "07-04-200"], description: "",
    };

    await act(async () => { capturedOnShowOnMap!(item); });

    expect(mockSetPinnedParts).toHaveBeenCalledWith([
      { binCode: "03-01-010", label: "MULTI-BIN", aisleNum: 3, partId: 2, sizeLabel: "—" },
      { binCode: "07-04-200", label: "MULTI-BIN", aisleNum: 7, partId: 2, sizeLabel: "—" },
    ]);
  });

  it("calls showToast and does NOT call setPinnedParts when binLocations is empty", async () => {
    await renderSearch();

    await act(async () => {
      capturedOnShowOnMap!({ id: 3, catalog: "NO-BIN", binLocations: [], description: "" });
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining("No bin location")
    );
    expect(mockSetPinnedParts).not.toHaveBeenCalled();
  });

  it("calls showToast and skips navigation when all bin codes are unrecognised", async () => {
    await renderSearch();

    await act(async () => {
      capturedOnShowOnMap!({
        id: 4, catalog: "BAD-BIN",
        binLocations: ["INVALID-FORMAT"], description: "",
      });
    });

    expect(mockShowToast).toHaveBeenCalled();
    expect(mockRouterNavigate).not.toHaveBeenCalledWith("/(tabs)/map");
  });

  it("pins aisle 0 when the first bin segment is 00 and navigates to the map tab", async () => {
    await renderSearch();

    const item = {
      id: 5, catalog: "AISLE-ZERO",
      binLocations: ["00-02-001"], description: "",
    };

    await act(async () => { capturedOnShowOnMap!(item); });

    expect(mockSetPinnedParts).toHaveBeenCalledWith([
      { binCode: "00-02-001", label: "AISLE-ZERO", aisleNum: 0, partId: 5, sizeLabel: "—" },
    ]);
    expect(mockRouterNavigate).toHaveBeenCalledWith("/(tabs)/map");
  });
});

// =============================================================================
// 2. SearchScreen – useFocusEffect consumes pendingMeasureSearch
// =============================================================================

describe("SearchScreen – useFocusEffect consumes pendingMeasureSearch", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.runAllTimers(); jest.useRealTimers(); });

  it("calls setPendingMeasureSearch(null) to consume the pending value", async () => {
    await renderSearch({
      pendingMeasureSearch: {
        minLength: "100", maxLength: "100",
        minWidth: "50", maxWidth: "50",
        minHeight: "25", maxHeight: "25",
        minDiameter: "", maxDiameter: "",
      },
    });

    // Manually fire the focus callback (simulates the screen coming into focus).
    await act(async () => { capturedFocusEffect?.(); });

    expect(mockSetPendingMeasureSearch).toHaveBeenCalledWith(null);
  });

  it("fires searchMutation.mutate inside the 0ms setTimeout with dimension filters applied", async () => {
    const { buildSearchBody } = require("@/utils/searchHelpers") as {
      buildSearchBody: jest.Mock;
    };

    await renderSearch({
      pendingMeasureSearch: {
        minLength: "150", maxLength: "150",
        minWidth: "75", maxWidth: "75",
        minHeight: "30", maxHeight: "30",
        minDiameter: "", maxDiameter: "",
      },
    });

    await act(async () => {
      capturedFocusEffect?.();
      // The effect schedules work in a 0ms setTimeout; advance past it.
      jest.advanceTimersByTime(1);
    });

    expect(mockSearchMutate).toHaveBeenCalled();
    // buildSearchBody must have been called with the dimension bounds applied.
    // Second arg is activeCategorySlugRef.current which is null by default.
    expect(buildSearchBody).toHaveBeenCalledWith(
      expect.objectContaining({ minLength: "150", maxLength: "150", minWidth: "75", maxWidth: "75", minHeight: "30", maxHeight: "30" }),
      null,
    );
  });

  it("does NOT fire when pendingMeasureSearch is null", async () => {
    await renderSearch({ pendingMeasureSearch: null });

    await act(async () => {
      capturedFocusEffect?.();
      jest.advanceTimersByTime(1);
    });

    expect(mockSetPendingMeasureSearch).not.toHaveBeenCalled();
    expect(mockSearchMutate).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. PhotoScreen – mapPromptBins after a successful identify+search
// =============================================================================

describe("PhotoScreen – mapPromptBins set after identify+search with binned top result", () => {
  it("shows the 'Part pinned on map' banner and calls setPinnedParts", async () => {
    mockIdentifyMutateAsync.mockResolvedValue({
      summary: "Circuit breaker",
      searchTerms: ["breaker"],
      synonyms: [],
      detectedVendor: null,
    });
    mockSearchMutateAsync.mockResolvedValue({
      results: [
        {
          item: {
            id: 10,
            catalog: "BR120",
            binLocations: ["04-01-001"],
            description: "120V breaker",
            dimensions: null,
          },
          confidence: 0.95,
          matchReason: "keyword",
          seriesLabel: null,
          variants: [],
        },
      ],
    });

    const tree = await renderPhoto();

    // Add an image so the Identify button is enabled.
    const libraryBtn = findPressable(tree.root, "Photo Library");
    expect(libraryBtn).not.toBeNull();
    await act(async () => { libraryBtn!.props.onPress(); });
    await flushPromises();

    // Press Identify — fires handleIdentify which awaits both mutations.
    const identifyBtn = findPressable(tree.root, "Identify Part");
    expect(identifyBtn).not.toBeNull();
    await act(async () => { identifyBtn!.props.onPress(); });
    await flushPromises();

    // "Part pinned on map" inline banner should now be visible.
    expect(hasText(tree.root, "Part pinned on map")).toBe(true);

    // setPinnedParts must have been called with a pin for bin "04-01-001" (aisle 4).
    expect(mockSetPinnedParts).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ binCode: "04-01-001", aisleNum: 4 }),
      ]),
    );
  });

  it("does NOT show the banner when the top result has no bin locations", async () => {
    mockIdentifyMutateAsync.mockResolvedValue({
      summary: "Unknown part", searchTerms: ["part"], synonyms: [], detectedVendor: null,
    });
    mockSearchMutateAsync.mockResolvedValue({
      results: [
        {
          item: {
            id: 11, catalog: "UNPLACED",
            binLocations: [], description: "No bin", dimensions: null,
          },
          confidence: 0.9, matchReason: "keyword", seriesLabel: null, variants: [],
        },
      ],
    });

    const tree = await renderPhoto();

    const libraryBtn = findPressable(tree.root, "Photo Library");
    await act(async () => { libraryBtn!.props.onPress(); });
    await flushPromises();

    const identifyBtn = findPressable(tree.root, "Identify Part");
    await act(async () => { identifyBtn!.props.onPress(); });
    await flushPromises();

    expect(hasText(tree.root, "Part pinned on map")).toBe(false);
  });
});

// =============================================================================
// 4. PhotoScreen – MeasurePartScreen onConfirm (admin search mode)
//    The admin ternary renders MeasurePartScreen only when isAdmin && adminToken.
//    The MeasurePartScreen mock captures the real inline onConfirm callback.
// =============================================================================

describe("PhotoScreen – MeasurePartScreen confirm (admin search mode)", () => {
  it("calls setPendingMeasureSearch with a MeasureSearchParams object", async () => {
    await renderPhoto({ isAdmin: true, adminToken: "test-token" });

    // MeasurePartScreen was rendered by the admin ternary; onConfirm is captured.
    expect(capturedMeasureConfirm).not.toBeNull();

    await act(async () => {
      capturedMeasureConfirm!({ length: 200, width: 100, height: 50, diameter: null });
    });

    expect(mockSetPendingMeasureSearch).toHaveBeenCalledWith({
      minLength: "200", maxLength: "200",
      minWidth: "100", maxWidth: "100",
      minHeight: "50", maxHeight: "50",
      minDiameter: "", maxDiameter: "",
    });
  });

  it("navigates to '/' (Search tab root) after confirming dimensions", async () => {
    await renderPhoto({ isAdmin: true, adminToken: "test-token" });

    await act(async () => {
      capturedMeasureConfirm!({ length: 100, width: 50, height: 25, diameter: null });
    });

    expect(mockRouterNavigate).toHaveBeenCalledWith("/");
  });

  it("builds a MeasureSearchParams object for diameter-only dims", async () => {
    await renderPhoto({ isAdmin: true, adminToken: "test-token" });

    await act(async () => {
      capturedMeasureConfirm!({ length: null, width: null, height: null, diameter: 38 });
    });

    expect(mockSetPendingMeasureSearch).toHaveBeenCalledWith({
      minLength: "", maxLength: "",
      minWidth: "", maxWidth: "",
      minHeight: "", maxHeight: "",
      minDiameter: "38", maxDiameter: "38",
    });
  });
});

// =============================================================================
// 5. WarehouseMapView – focusAisleNum effect: no-zone-found cleanup path
//
//    When focusAisleNum is set but zones.find() returns undefined, the effect
//    must call onFocusConsumed (and onFocusFailed) to release the pending focus
//    so the parent does not re-trigger the animation on every subsequent render.
//
//    The effect is gated on containerW > 0 (i.e. a layout event has fired), so
//    we locate the outer View with an onLayout prop in the rendered tree and
//    call it with synthetic dimensions before asserting.
// =============================================================================

describe("WarehouseMapView – focusAisleNum effect calls onFocusConsumed when no zone matches", () => {
  it("calls onFocusConsumed exactly once and onFocusFailed exactly once", async () => {
    useApp.mockReturnValue(makeTestAppMock());

    const onFocusConsumed = jest.fn();
    const onFocusFailed   = jest.fn();

    // A zone list that has no entry with aisleId "1" so the find() misses.
    const zones: Parameters<typeof WarehouseMapView>[0]["zones"] = [
      {
        id: 99, aisleId: "99",
        sectionNum: 0, isInventory: true,
        svgX: 100, svgY: 100, svgWidth: 200, svgHeight: 150,
        sortOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      },
    ];

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <WarehouseMapView
          zones={zones}
          zonesLoading={false}
          zonesError={false}
          onZonesRetry={jest.fn()}
          onZoneTap={jest.fn()}
          focusAisleNum={1}
          onFocusConsumed={onFocusConsumed}
          onFocusFailed={onFocusFailed}
        />
      );
    });
    activeTree = tree;
    await flushPromises();

    // containerWRef starts at 0 — the guard (w === 0) blocks the zone lookup.
    // Simulate a layout event on the outer View to give the component real
    // dimensions, which re-runs the focusAisleNum effect past the guard.
    const viewWithLayout = tree.root.findAll(
      (n) => typeof n.props.onLayout === "function",
      { deep: true }
    )[0];
    expect(viewWithLayout).toBeDefined();

    await act(async () => {
      viewWithLayout!.props.onLayout({
        nativeEvent: { layout: { width: 400, height: 800 } },
      });
    });
    await flushPromises();

    // zones has aisleId "99" but focusAisleNum is 1 → no match →
    // cleanup callbacks must each fire exactly once.
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
    expect(onFocusFailed).toHaveBeenCalledTimes(1);
  });
});
