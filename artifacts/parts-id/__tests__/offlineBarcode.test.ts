/**
 * @jest-environment node
 *
 * Unit tests for the offline barcode cache utilities.
 * Covers:
 *   - lookupByBarcodeOffline: found, not-found, empty cache, corrupt cache
 *   - upsertItemInBarcodeCache: update existing, insert new, cap guard, empty cache
 *   - getFuseCacheSyncedAt: valid timestamp, missing key, non-numeric value
 *   - Deleted-item cache guard: item removed from server is not in a refreshed cache
 */

import {
  lookupByBarcodeOffline,
  upsertItemInBarcodeCache,
  getFuseCacheSyncedAt,
  FUSE_CACHE_KEY,
  FUSE_CACHE_SYNCED_AT_KEY,
  MAX_FUSE_CACHE_ITEMS,
} from "../utils/offlineBarcode";
import type { InventoryItem } from "@workspace/api-client-react";

// ── AsyncStorage mock ─────────────────────────────────────────────────────────
const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();
const mockRemoveItem = jest.fn<Promise<void>, [string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
    removeItem: (...args: [string]) => mockRemoveItem(...args),
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

function cacheWith(items: InventoryItem[]): string {
  return JSON.stringify(items);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSetItem.mockResolvedValue(undefined);
  mockRemoveItem.mockResolvedValue(undefined);
});

// ── lookupByBarcodeOffline ────────────────────────────────────────────────────

describe("lookupByBarcodeOffline", () => {
  it("returns the matching item when its barcode is in the cache", async () => {
    const item = makeItem(1, ["ABC-001"]);
    mockGetItem.mockResolvedValue(cacheWith([item]));

    const result = await lookupByBarcodeOffline("ABC-001");
    expect(result).not.toBeNull();
    expect(result?.id).toBe(1);
    expect(result?.catalog).toBe("CAT-1");
  });

  it("returns null when the barcode is not in any cached item", async () => {
    const item = makeItem(1, ["XYZ-999"]);
    mockGetItem.mockResolvedValue(cacheWith([item]));

    expect(await lookupByBarcodeOffline("ABC-001")).toBeNull();
  });

  it("returns null when AsyncStorage has no cache entry", async () => {
    mockGetItem.mockResolvedValue(null);
    expect(await lookupByBarcodeOffline("ABC-001")).toBeNull();
  });

  it("returns null when AsyncStorage returns an empty string", async () => {
    mockGetItem.mockResolvedValue("");
    expect(await lookupByBarcodeOffline("ABC-001")).toBeNull();
  });

  it("returns null when the cached JSON is corrupt", async () => {
    mockGetItem.mockResolvedValue("not-valid-json{{");
    expect(await lookupByBarcodeOffline("ABC-001")).toBeNull();
  });

  it("returns null when AsyncStorage.getItem throws", async () => {
    mockGetItem.mockRejectedValue(new Error("storage error"));
    expect(await lookupByBarcodeOffline("ABC-001")).toBeNull();
  });

  it("finds the correct item when multiple items are cached", async () => {
    const items = [
      makeItem(10, ["SCAN-A"]),
      makeItem(20, ["SCAN-B"]),
      makeItem(30, ["SCAN-C"]),
    ];
    mockGetItem.mockResolvedValue(cacheWith(items));

    const result = await lookupByBarcodeOffline("SCAN-B");
    expect(result?.id).toBe(20);
  });

  it("returns null for a barcode that was removed when the cache was refreshed (deleted-item guard)", async () => {
    // Server deletes item 5 — next full sync writes a cache without it
    const freshCache = [makeItem(1, ["KEEP-1"]), makeItem(2, ["KEEP-2"])];
    mockGetItem.mockResolvedValue(cacheWith(freshCache));

    // The deleted item's barcode is no longer in the refreshed cache
    expect(await lookupByBarcodeOffline("DELETED-5")).toBeNull();
  });
});

// ── upsertItemInBarcodeCache ──────────────────────────────────────────────────

describe("upsertItemInBarcodeCache", () => {
  it("updates an existing item in the cache by id", async () => {
    const original = makeItem(1, ["OLD-BC"]);
    mockGetItem.mockResolvedValue(cacheWith([original]));

    const updated = makeItem(1, ["OLD-BC", "NEW-BC"]);
    await upsertItemInBarcodeCache(updated);

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [key, raw] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(FUSE_CACHE_KEY);
    const saved = JSON.parse(raw) as InventoryItem[];
    expect(saved).toHaveLength(1);
    expect(saved[0].barcodes).toContain("NEW-BC");
  });

  it("appends a new item to the cache when the id is not present", async () => {
    const existing = makeItem(1, ["BC-1"]);
    mockGetItem.mockResolvedValue(cacheWith([existing]));

    const newItem = makeItem(99, ["BC-99"]);
    await upsertItemInBarcodeCache(newItem);

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const saved = JSON.parse(raw) as InventoryItem[];
    expect(saved).toHaveLength(2);
    expect(saved.some((i) => i.id === 99)).toBe(true);
  });

  it("inserts into an empty cache without error", async () => {
    mockGetItem.mockResolvedValue(null);

    const item = makeItem(7, ["BC-007"]);
    await upsertItemInBarcodeCache(item);

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const saved = JSON.parse(raw) as InventoryItem[];
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(7);
  });

  it("does not append a new item when the cache is at MAX_FUSE_CACHE_ITEMS", async () => {
    const fullCache = Array.from({ length: MAX_FUSE_CACHE_ITEMS }, (_, i) =>
      makeItem(i + 1),
    );
    mockGetItem.mockResolvedValue(JSON.stringify(fullCache));

    const extra = makeItem(9999, ["OVERFLOW"]);
    await upsertItemInBarcodeCache(extra);

    // setItem should NOT have been called (guard bails out early)
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it("still updates an existing item even when the cache is at the cap", async () => {
    const fullCache = Array.from({ length: MAX_FUSE_CACHE_ITEMS }, (_, i) =>
      makeItem(i + 1),
    );
    // item id=1 is in the cache
    const targetId = 1;
    mockGetItem.mockResolvedValue(JSON.stringify(fullCache));

    const updated = { ...fullCache[0], barcodes: ["UPDATED-BC"] } as InventoryItem;
    await upsertItemInBarcodeCache(updated);

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const saved = JSON.parse(raw) as InventoryItem[];
    const found = saved.find((i) => i.id === targetId);
    expect(found?.barcodes).toContain("UPDATED-BC");
  });

  it("silently ignores AsyncStorage errors", async () => {
    mockGetItem.mockRejectedValue(new Error("io error"));
    await expect(upsertItemInBarcodeCache(makeItem(1))).resolves.toBeUndefined();
  });
});

// ── getFuseCacheSyncedAt ──────────────────────────────────────────────────────

describe("getFuseCacheSyncedAt", () => {
  it("returns the stored timestamp as a number", async () => {
    const ts = 1_700_000_000_000;
    mockGetItem.mockImplementation((key) =>
      key === FUSE_CACHE_SYNCED_AT_KEY
        ? Promise.resolve(String(ts))
        : Promise.resolve(null),
    );

    expect(await getFuseCacheSyncedAt()).toBe(ts);
  });

  it("returns null when the key is not set", async () => {
    mockGetItem.mockResolvedValue(null);
    expect(await getFuseCacheSyncedAt()).toBeNull();
  });

  it("returns null for a non-numeric stored value", async () => {
    mockGetItem.mockResolvedValue("not-a-number");
    expect(await getFuseCacheSyncedAt()).toBeNull();
  });

  it("returns null when AsyncStorage throws", async () => {
    mockGetItem.mockRejectedValue(new Error("disk full"));
    expect(await getFuseCacheSyncedAt()).toBeNull();
  });
});
