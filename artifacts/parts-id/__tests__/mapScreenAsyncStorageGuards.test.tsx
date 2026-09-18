/**
 * Tests for AsyncStorage guard logic in MapScreen (app/(tabs)/map.tsx, lines 252–290).
 *
 * Three scenarios are covered:
 *
 *  1. Unmount before AsyncStorage resolves — the `alive` flag must prevent any
 *     setState call after the component has been torn down.  Verified by
 *     confirming WarehouseMapView receives no additional renders (render counter
 *     stays at the last value recorded before unmount), and no [map] console
 *     output fires.
 *
 *  2. Non-array value for CYCLE_COUNTED_KEY — the parser guard emits
 *     `console.warn('[map] CYCLE_COUNTED_KEY: expected array, got …')` and
 *     returns early so setCountedZoneIds is never reached.  Verified by asserting
 *     that the `countedZoneIds` prop passed to WarehouseMapView remains an empty
 *     Set (initial value), confirming no state update occurred.
 *
 *  3. Non-array value for FUSE_CACHE_KEY — the parser guard emits
 *     `console.warn('[map] FUSE_CACHE_KEY: expected array, got …')` and returns
 *     early so setInventory is never reached.  Verified by asserting that the
 *     `inventory` prop passed to AisleSummarySheet remains an empty array
 *     (initial value), confirming no state update occurred.
 *
 * Mock strategy
 * ─────────────
 * All native modules are stubbed inline.  WarehouseMapView and AisleSummarySheet
 * capture their props on every render so tests can inspect post-flush state.
 * AsyncStorage.getItem is overridden per-test: deferred Promise (unmount test)
 * or resolved Promise carrying a non-array JSON string (corrupt-value tests).
 */

// Required for act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import { makeAppMock, flushPromises as rawFlush } from "./helpers/appMocks";

// ─── expo-router ──────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  router:         { navigate: jest.fn(), push: jest.fn() },
  useFocusEffect: jest.fn(),
  useRouter:      () => ({ navigate: jest.fn(), push: jest.fn() }),
}));

// ─── expo-screen-orientation ─────────────────────────────────────────────────

jest.mock("expo-screen-orientation", () => ({
  unlockAsync:     jest.fn().mockResolvedValue(undefined),
  lockAsync:       jest.fn().mockResolvedValue(undefined),
  OrientationLock: { PORTRAIT_UP: "PORTRAIT_UP" },
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────
// Exposed as a single jest.fn() so individual tests can override its behaviour.

const mockGetItem = jest.fn<Promise<string | null>, [string]>(() =>
  Promise.resolve(null),
);

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    mockGetItem,
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── @/utils/useTrackScreen ──────────────────────────────────────────────────

jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));

// ─── @/utils/orientationLock ─────────────────────────────────────────────────

jest.mock("@/utils/orientationLock", () => ({
  swallowOrientationNotAvailable: jest.fn(),
}));

// ─── @/utils/offlineBarcode ──────────────────────────────────────────────────

jest.mock("@/utils/offlineBarcode", () => ({
  FUSE_CACHE_KEY:           "fuse_cache",
  FUSE_CACHE_SYNCED_AT_KEY: "fuse_synced_at",
  getFuseCacheSyncedAt:     jest.fn().mockResolvedValue(Date.now()),
  FUSE_SYNC_MAX_AGE_MS:     Infinity,
  FUSE_SOFT_STALE_MS:       Infinity,
  lookupByBarcodeOffline:   jest.fn().mockResolvedValue(null),
  // Mirrors the real parser: envelope format { items: [...] }, legacy plain
  // array, or null for anything else (which triggers the corrupt-value warn).
  parseFuseCacheItems: jest.fn((raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.items)) return parsed.items;
      return null;
    } catch {
      return null;
    }
  }),
  replaceBarcodeCacheWithServerItems: jest.fn().mockResolvedValue(undefined),
}));

// ─── @/hooks/useWarehouseZones ───────────────────────────────────────────────

jest.mock("@/hooks/useWarehouseZones", () => ({
  useWarehouseZones: jest.fn(() => ({
    zones:   [],
    anchors: [],
    loading: false,
    error:   false,
    refetch: jest.fn(),
  })),
}));

// ─── @/components/WarehouseMapView — prop-capturing mock ─────────────────────
// Stores the most-recently received props AND increments a render counter
// so tests can detect unexpected re-renders after unmount.

let capturedMapViewProps: Record<string, unknown>    = {};
let mapViewRenderCount  = 0;

jest.mock("@/components/WarehouseMapView", () => ({
  WarehouseMapView: (props: Record<string, unknown>) => {
    capturedMapViewProps = props;
    mapViewRenderCount  += 1;
    return null;
  },
}));

// ─── @/components/ZoneActionMenu — null stub ─────────────────────────────────

jest.mock("@/components/ZoneActionMenu", () => ({
  ZoneActionMenu: () => null,
}));

// ─── @/components/AisleSummarySheet — prop-capturing mock ────────────────────
// `inventory` flows to this component from MapScreen (line 562 of map.tsx).

let capturedSummaryProps: Record<string, unknown> = {};

jest.mock("@/components/AisleSummarySheet", () => ({
  AisleSummarySheet: (props: Record<string, unknown>) => {
    capturedSummaryProps = props;
    return null;
  },
}));

// ─── @/components/BrowseByAisle — null stub ──────────────────────────────────

jest.mock("@/components/BrowseByAisle", () => ({
  BrowseByAisle: () => null,
}));

// ─── react-native-reanimated ─────────────────────────────────────────────────

jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());

// ─── react-native-gesture-handler ────────────────────────────────────────────
// Handled automatically by moduleNameMapper in jest.config.js → __mocks__/react-native-gesture-handler.js

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());

// ─── expo-asset ───────────────────────────────────────────────────────────────

jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());

// ─── @/utils/floorPlanCache ──────────────────────────────────────────────────

jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

// ─── @/utils/mapViewport ─────────────────────────────────────────────────────

jest.mock("@/utils/mapViewport", () => require("./helpers/mapMocks").createMapViewportMock());

// ─── expo-clipboard ──────────────────────────────────────────────────────────

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

// ─── AppContext ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── Console spy setup ───────────────────────────────────────────────────────

let warnSpy:  jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeAll(() => {
  warnSpy  = jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      (console.error as unknown as { _original?: (...a: unknown[]) => void })
        ._original?.(msg, ...args);
    },
  );
});

afterAll(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

// ─── Per-test setup / teardown ───────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  useApp.mockReturnValue(makeAppMock());
  jest.clearAllMocks();
  warnSpy.mockClear();
  errorSpy.mockClear();
  capturedMapViewProps  = {};
  capturedSummaryProps  = {};
  mapViewRenderCount    = 0;
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
});

// ─── Subject under test ───────────────────────────────────────────────────────

import MapScreen from "../app/(tabs)/map";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const flushPromises = () => act(async () => { await rawFlush(); });

// =============================================================================
// 1. Unmount before AsyncStorage resolves — alive guard prevents post-unmount
//    setState calls
// =============================================================================

describe("MapScreen — unmount before AsyncStorage resolves", () => {
  it("no React unmounted-state warning, no extra renders, no [map] logs after deferred AsyncStorage resolves post-unmount", async () => {
    let resolveCycleCount!: (v: string | null) => void;
    let resolveFuseCache!:  (v: string | null) => void;

    const cycleCountDeferred = new Promise<string | null>((r) => { resolveCycleCount = r; });
    const fuseCacheDeferred  = new Promise<string | null>((r) => { resolveFuseCache  = r; });

    mockGetItem.mockImplementation((key: string) => {
      if (key === "CYCLE_COUNTED_IDS") return cycleCountDeferred;
      if (key === "fuse_cache")        return fuseCacheDeferred;
      return Promise.resolve(null);
    });

    activeTree = await render(<MapScreen />);

    const renderCountBeforeUnmount = mapViewRenderCount;
    expect(renderCountBeforeUnmount).toBeGreaterThan(0);

    await activeTree.unmount();
    activeTree = null;

    // Clear any mount-time console output so we only see post-unmount calls.
    warnSpy.mockClear();
    errorSpy.mockClear();

    // Resolve both deferred promises with valid payloads — without the `alive`
    // guard these would reach `setCountedZoneIds` / `setInventory`.
    resolveCycleCount(JSON.stringify([1, 2, 3]));
    resolveFuseCache(JSON.stringify([{ id: "x", description: "part", bin: "A1", quantity: 1 }]));

    await flushPromises();

    // Primary assertion: React must not emit "state update on an unmounted
    // component" (reintroduced in a future React version or error-boundary).
    const errorMessages = errorSpy.mock.calls.map((c) => String(c[0]));
    const unmountedWarnings = errorMessages.filter(
      (m) =>
        m.toLowerCase().includes("unmounted component") ||
        m.toLowerCase().includes("state update") ||
        m.includes("Can't perform a React state update"),
    );
    expect(unmountedWarnings).toHaveLength(0);

    // Supplemental: no re-render of WarehouseMapView occurred after unmount.
    expect(mapViewRenderCount).toBe(renderCountBeforeUnmount);

    // Supplemental: no [map]-namespaced warn/error output fired.
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.filter((m) => m.includes("[map]"))).toHaveLength(0);
    expect(errorMessages.filter((m) => m.includes("[map]"))).toHaveLength(0);
  });
});

// =============================================================================
// 2. Non-array CYCLE_COUNTED_KEY — warn is emitted, setCountedZoneIds never
//    reached (countedZoneIds prop on WarehouseMapView stays empty Set)
// =============================================================================

describe("MapScreen — corrupt CYCLE_COUNTED_KEY (non-array value)", () => {
  it("emits console.warn and leaves countedZoneIds as an empty Set when stored value is an object", async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === "CYCLE_COUNTED_IDS") return Promise.resolve(JSON.stringify({ bad: true }));
      return Promise.resolve(null);
    });

    activeTree = await render(<MapScreen />);
    await flushPromises();

    const relevant = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("CYCLE_COUNTED_KEY"),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    expect(relevant[0][0]).toMatch(/\[map\] CYCLE_COUNTED_KEY: expected array, got/);
    expect(relevant[0][1]).toBe("object");

    const countedZoneIds = capturedMapViewProps.countedZoneIds as Set<number>;
    expect(countedZoneIds).toBeInstanceOf(Set);
    expect(countedZoneIds.size).toBe(0);
  });

  it("emits console.warn and leaves countedZoneIds as an empty Set when stored value is a plain number", async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === "CYCLE_COUNTED_IDS") return Promise.resolve(JSON.stringify(42));
      return Promise.resolve(null);
    });

    activeTree = await render(<MapScreen />);
    await flushPromises();

    const relevant = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("CYCLE_COUNTED_KEY"),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    expect(relevant[0][1]).toBe("number");

    const countedZoneIds = capturedMapViewProps.countedZoneIds as Set<number>;
    expect(countedZoneIds).toBeInstanceOf(Set);
    expect(countedZoneIds.size).toBe(0);
  });

  it("does NOT emit the CYCLE_COUNTED_KEY warning and populates countedZoneIds when value is a valid array", async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === "CYCLE_COUNTED_IDS") return Promise.resolve(JSON.stringify([7, 12]));
      return Promise.resolve(null);
    });

    activeTree = await render(<MapScreen />);
    await flushPromises();

    const relevant = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("CYCLE_COUNTED_KEY"),
    );
    expect(relevant).toHaveLength(0);

    const countedZoneIds = capturedMapViewProps.countedZoneIds as Set<number>;
    expect(countedZoneIds).toBeInstanceOf(Set);
    expect(countedZoneIds.size).toBe(2);
    expect(countedZoneIds.has(7)).toBe(true);
    expect(countedZoneIds.has(12)).toBe(true);
  });
});

// =============================================================================
// 3. Non-array FUSE_CACHE_KEY — warn is emitted, setInventory never reached
//    (inventory prop on AisleSummarySheet stays empty array)
// =============================================================================

describe("MapScreen — corrupt FUSE_CACHE_KEY (non-array value)", () => {
  it("emits console.warn and leaves inventory as an empty array when stored value is an object", async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === "fuse_cache") return Promise.resolve(JSON.stringify({ corrupted: true }));
      return Promise.resolve(null);
    });

    activeTree = await render(<MapScreen />);
    await flushPromises();

    const relevant = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("FUSE_CACHE_KEY"),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    expect(relevant[0][0]).toMatch(/\[map\] FUSE_CACHE_KEY: expected array, got/);
    expect(relevant[0][1]).toBe("object");

    const inventory = capturedSummaryProps.inventory as unknown[];
    expect(Array.isArray(inventory)).toBe(true);
    expect(inventory.length).toBe(0);
  });

  it("emits console.warn and leaves inventory as an empty array when stored value is a boolean", async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === "fuse_cache") return Promise.resolve(JSON.stringify(false));
      return Promise.resolve(null);
    });

    activeTree = await render(<MapScreen />);
    await flushPromises();

    const relevant = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("FUSE_CACHE_KEY"),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    expect(relevant[0][1]).toBe("boolean");

    const inventory = capturedSummaryProps.inventory as unknown[];
    expect(Array.isArray(inventory)).toBe(true);
    expect(inventory.length).toBe(0);
  });

  it("does NOT emit the FUSE_CACHE_KEY warning and populates inventory when value is a valid array", async () => {
    const item = { id: "p1", description: "Part One", bin: "A1", quantity: 5 };
    mockGetItem.mockImplementation((key: string) => {
      if (key === "fuse_cache") return Promise.resolve(JSON.stringify([item]));
      return Promise.resolve(null);
    });

    activeTree = await render(<MapScreen />);
    await flushPromises();

    const relevant = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("FUSE_CACHE_KEY"),
    );
    expect(relevant).toHaveLength(0);

    const inventory = capturedSummaryProps.inventory as unknown[];
    expect(Array.isArray(inventory)).toBe(true);
    expect(inventory.length).toBe(1);
  });
});
