/**
 * @jest-environment node
 *
 * Integration-style tests for the barcode-resolver utilities extracted from
 * BarcodeScreen.  Covers the three lookup tiers plus the shelf-assign flow.
 *
 * Covered scenarios
 * ─────────────────
 * resolveBarcodeCode
 *   1. API returns an item → phase "found", isOffline false
 *   2. API returns 404 → phase "notfound" (deleted-item guard: local cache NOT consulted)
 *   3. Network unreachable (status === null) and item is in local cache → phase "found", isOffline true
 *   4. Network unreachable and item is NOT in local cache → phase "offline_miss"
 *   5. API returns a non-404 HTTP error (e.g. 500) → phase "error"
 *   6. Deleted item: 404 is returned even when the same barcode IS in the offline cache
 *
 * resolveShelfAssign
 *   7. Barcode is new → updateBarcodes called, cache upserted, wasNew: true
 *   8. Barcode already exists on item → no API call, no cache update, wasNew: false
 *   9. updateBarcodes throws → error propagates to caller
 */

import {
  resolveBarcodeCode,
  resolveShelfAssign,
} from "../utils/barcodeResolver";
import type { InventoryItem } from "@workspace/api-client-react";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock the entire api-client-react module so lookupByBarcode can be controlled.
const mockLookupByBarcode = jest.fn<Promise<InventoryItem>, [string]>();
jest.mock("@workspace/api-client-react", () => ({
  lookupByBarcode: (...args: [string]) => mockLookupByBarcode(...args),
}));

// Mock AsyncStorage (consumed by lookupByBarcodeOffline through offlineBarcode.ts).
const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
    removeItem: jest.fn(() => Promise.resolve()),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(id: number, barcodes: string[] = []): InventoryItem {
  return {
    id,
    catalog: `CAT-${id}`,
    vendor: "TestVendor",
    description: `Item ${id}`,
    binLocations: [],
    barcodes,
    aiKeywords: [],
    imageUrl: null,
    quantity: 0,
  } as unknown as InventoryItem;
}

function apiError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

/** Simulates a completely unreachable server — error has no .status property. */
function networkError(): Error {
  return new Error("Network request failed");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSetItem.mockResolvedValue(undefined);
});

// ── resolveBarcodeCode ────────────────────────────────────────────────────────

describe("resolveBarcodeCode", () => {
  it("returns phase 'found' with isOffline false when the API succeeds", async () => {
    const item = makeItem(1, ["SCAN-001"]);
    mockLookupByBarcode.mockResolvedValue(item);
    mockGetItem.mockResolvedValue(null); // offline cache is not consulted

    const result = await resolveBarcodeCode("SCAN-001");

    expect(result.phase).toBe("found");
    if (result.phase === "found") {
      expect(result.item.id).toBe(1);
      expect(result.isOffline).toBe(false);
    }
    // Online lookup succeeded — offline cache must NOT have been consulted
    expect(mockGetItem).not.toHaveBeenCalled();
  });

  it("returns phase 'notfound' when the API returns 404", async () => {
    mockLookupByBarcode.mockRejectedValue(apiError(404));
    // Even if the barcode is in the local cache, 404 is authoritative
    mockGetItem.mockResolvedValue(null);

    const result = await resolveBarcodeCode("UNKNOWN-BC");
    expect(result.phase).toBe("notfound");
  });

  it("deleted-item guard: returns 'notfound' even when the barcode IS in the offline cache", async () => {
    // Server says 404 (item deleted) but the stale cache still has it
    mockLookupByBarcode.mockRejectedValue(apiError(404));
    const cachedItem = makeItem(99, ["DELETED-BC"]);
    mockGetItem.mockResolvedValue(JSON.stringify([cachedItem]));

    const result = await resolveBarcodeCode("DELETED-BC");
    // Must NOT show the stale cached item — the 404 is the authoritative answer
    expect(result.phase).toBe("notfound");
    // Offline cache should not have been consulted
    expect(mockGetItem).not.toHaveBeenCalled();
  });

  it("returns phase 'found' with isOffline true when network is unreachable and cache hits", async () => {
    mockLookupByBarcode.mockRejectedValue(networkError());
    const offlineItem = makeItem(7, ["BC-007"]);
    mockGetItem.mockResolvedValue(JSON.stringify([offlineItem]));

    const result = await resolveBarcodeCode("BC-007");

    expect(result.phase).toBe("found");
    if (result.phase === "found") {
      expect(result.item.id).toBe(7);
      expect(result.isOffline).toBe(true);
    }
  });

  it("returns phase 'offline_miss' when network is unreachable and cache has no match", async () => {
    mockLookupByBarcode.mockRejectedValue(networkError());
    mockGetItem.mockResolvedValue(null); // empty cache

    const result = await resolveBarcodeCode("NO-MATCH");
    expect(result.phase).toBe("offline_miss");
  });

  it("returns phase 'error' for a non-404 HTTP error (e.g. 500)", async () => {
    mockLookupByBarcode.mockRejectedValue(apiError(500));

    const result = await resolveBarcodeCode("BC-500");
    expect(result.phase).toBe("error");
    if (result.phase === "error") {
      expect(result.message).toBe("Lookup failed — please try again.");
    }
    // Offline cache must NOT be consulted for server-side errors
    expect(mockGetItem).not.toHaveBeenCalled();
  });
});

// ── resolveShelfAssign ────────────────────────────────────────────────────────

describe("resolveShelfAssign", () => {
  it("calls updateBarcodes and upsertCache when the barcode is new", async () => {
    const item = makeItem(10, ["EXISTING-BC"]);
    const updatedItem = makeItem(10, ["EXISTING-BC", "NEW-BC"]);
    const updateBarcodes = jest.fn().mockResolvedValue(updatedItem);
    const upsertCache = jest.fn().mockResolvedValue(undefined);

    const result = await resolveShelfAssign("NEW-BC", item, updateBarcodes, upsertCache);

    expect(result.wasNew).toBe(true);
    if (result.wasNew) {
      expect(result.updatedItem).toEqual(updatedItem);
    }
    expect(updateBarcodes).toHaveBeenCalledTimes(1);
    expect(updateBarcodes).toHaveBeenCalledWith(10, ["EXISTING-BC", "NEW-BC"]);
    expect(upsertCache).toHaveBeenCalledTimes(1);
    expect(upsertCache).toHaveBeenCalledWith(updatedItem);
  });

  it("returns wasNew: false and skips mutations when the barcode already exists", async () => {
    const item = makeItem(10, ["ALREADY-BC"]);
    const updateBarcodes = jest.fn();
    const upsertCache = jest.fn();

    const result = await resolveShelfAssign("ALREADY-BC", item, updateBarcodes, upsertCache);

    expect(result.wasNew).toBe(false);
    expect(updateBarcodes).not.toHaveBeenCalled();
    expect(upsertCache).not.toHaveBeenCalled();
  });

  it("assigns to an item with no existing barcodes", async () => {
    const item = makeItem(20, []); // barcodes array is empty
    const updatedItem = makeItem(20, ["FIRST-BC"]);
    const updateBarcodes = jest.fn().mockResolvedValue(updatedItem);
    const upsertCache = jest.fn().mockResolvedValue(undefined);

    const result = await resolveShelfAssign("FIRST-BC", item, updateBarcodes, upsertCache);

    expect(result.wasNew).toBe(true);
    expect(updateBarcodes).toHaveBeenCalledWith(20, ["FIRST-BC"]);
  });

  it("handles an item with undefined barcodes (null-safety)", async () => {
    const item = { ...makeItem(30), barcodes: undefined } as unknown as InventoryItem;
    const updatedItem = makeItem(30, ["BC-NULL"]);
    const updateBarcodes = jest.fn().mockResolvedValue(updatedItem);
    const upsertCache = jest.fn().mockResolvedValue(undefined);

    const result = await resolveShelfAssign("BC-NULL", item, updateBarcodes, upsertCache);
    expect(result.wasNew).toBe(true);
    expect(updateBarcodes).toHaveBeenCalledWith(30, ["BC-NULL"]);
  });

  it("propagates errors thrown by updateBarcodes to the caller", async () => {
    const item = makeItem(5, []);
    const updateBarcodes = jest.fn().mockRejectedValue(new Error("network error"));
    const upsertCache = jest.fn();

    await expect(
      resolveShelfAssign("BC-FAIL", item, updateBarcodes, upsertCache),
    ).rejects.toThrow("network error");
    // upsertCache should not have been called since updateBarcodes failed
    expect(upsertCache).not.toHaveBeenCalled();
  });
});
