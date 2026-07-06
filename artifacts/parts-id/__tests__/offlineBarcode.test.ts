/**
 * @jest-environment node
 *
 * Unit tests for the offline barcode cache utilities.
 * Covers:
 *   - lookupByBarcodeOffline: found, not-found, empty cache, corrupt cache
 *   - upsertItemInBarcodeCache: update existing, insert new, cap guard, empty cache
 *   - replaceBarcodeCacheWithServerItems: full sync write + deleted-item pruning
 *   - getFuseCacheSyncedAt: valid timestamp, missing key, non-numeric value,
 *     legacy plain-array format fallback
 *   - Deleted-item cache guard: item removed from server is not in a refreshed cache
 */

import {
  lookupByBarcodeOffline,
  upsertItemInBarcodeCache,
  replaceBarcodeCacheWithServerItems,
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

/** Serialise items in the new envelope format (produced by replaceBarcodeCacheWithServerItems). */
function envelopeWith(items: InventoryItem[], syncedAt: number | null = null): string {
  return JSON.stringify({ items, syncedAt });
}

/** Serialise items in the legacy plain-array format (written before the envelope migration). */
function legacyArrayWith(items: InventoryItem[]): string {
  return JSON.stringify(items);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSetItem.mockResolvedValue(undefined);
  mockRemoveItem.mockResolvedValue(undefined);
});

// ── lookupByBarcodeOffline ────────────────────────────────────────────────────

describe("lookupByBarcodeOffline", () => {
  it("returns the matching item when its barcode is in the cache (envelope format)", async () => {
    const item = makeItem(1, ["ABC-001"]);
    mockGetItem.mockResolvedValue(envelopeWith([item]));

    const result = await lookupByBarcodeOffline("ABC-001");
    expect(result).not.toBeNull();
    expect(result?.id).toBe(1);
    expect(result?.catalog).toBe("CAT-1");
  });

  it("returns the matching item when cache is in legacy plain-array format", async () => {
    const item = makeItem(1, ["ABC-001"]);
    mockGetItem.mockResolvedValue(legacyArrayWith([item]));

    const result = await lookupByBarcodeOffline("ABC-001");
    expect(result?.id).toBe(1);
  });

  it("returns null when the barcode is not in any cached item", async () => {
    const item = makeItem(1, ["XYZ-999"]);
    mockGetItem.mockResolvedValue(envelopeWith([item]));

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
    mockGetItem.mockResolvedValue(envelopeWith(items));

    const result = await lookupByBarcodeOffline("SCAN-B");
    expect(result?.id).toBe(20);
  });

  it("returns null for a barcode that was removed when the cache was refreshed (deleted-item guard)", async () => {
    // Server deletes item 5 — next full sync writes a cache without it
    const freshCache = [makeItem(1, ["KEEP-1"]), makeItem(2, ["KEEP-2"])];
    mockGetItem.mockResolvedValue(envelopeWith(freshCache));

    // The deleted item's barcode is no longer in the refreshed cache
    expect(await lookupByBarcodeOffline("DELETED-5")).toBeNull();
  });
});

// ── upsertItemInBarcodeCache ──────────────────────────────────────────────────

describe("upsertItemInBarcodeCache", () => {
  it("updates an existing item in the cache by id (reads legacy format, writes envelope)", async () => {
    const original = makeItem(1, ["OLD-BC"]);
    mockGetItem.mockResolvedValue(legacyArrayWith([original]));

    const updated = makeItem(1, ["OLD-BC", "NEW-BC"]);
    await upsertItemInBarcodeCache(updated);

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [key, raw] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(FUSE_CACHE_KEY);
    const saved = (JSON.parse(raw) as { items: InventoryItem[] }).items;
    expect(saved).toHaveLength(1);
    expect(saved[0].barcodes).toContain("NEW-BC");
  });

  it("updates an existing item when cache is in envelope format", async () => {
    const original = makeItem(1, ["OLD-BC"]);
    mockGetItem.mockResolvedValue(envelopeWith([original], 1_700_000_000_000));

    const updated = makeItem(1, ["NEW-BC"]);
    await upsertItemInBarcodeCache(updated);

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const parsed = JSON.parse(raw) as { items: InventoryItem[]; syncedAt: number | null };
    expect(parsed.items[0].barcodes).toContain("NEW-BC");
    // syncedAt from the existing envelope is preserved
    expect(parsed.syncedAt).toBe(1_700_000_000_000);
  });

  it("appends a new item to the cache when the id is not present", async () => {
    const existing = makeItem(1, ["BC-1"]);
    mockGetItem.mockResolvedValue(legacyArrayWith([existing]));

    const newItem = makeItem(99, ["BC-99"]);
    await upsertItemInBarcodeCache(newItem);

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const saved = (JSON.parse(raw) as { items: InventoryItem[] }).items;
    expect(saved).toHaveLength(2);
    expect(saved.some((i) => i.id === 99)).toBe(true);
  });

  it("inserts into an empty cache without error", async () => {
    mockGetItem.mockResolvedValue(null);

    const item = makeItem(7, ["BC-007"]);
    await upsertItemInBarcodeCache(item);

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const saved = (JSON.parse(raw) as { items: InventoryItem[] }).items;
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(7);
  });

  it("does not append a new item when the cache is at MAX_FUSE_CACHE_ITEMS", async () => {
    const fullCache = Array.from({ length: MAX_FUSE_CACHE_ITEMS }, (_, i) =>
      makeItem(i + 1),
    );
    mockGetItem.mockResolvedValue(legacyArrayWith(fullCache));

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
    mockGetItem.mockResolvedValue(legacyArrayWith(fullCache));

    const updated = { ...fullCache[0], barcodes: ["UPDATED-BC"] } as InventoryItem;
    await upsertItemInBarcodeCache(updated);

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const saved = (JSON.parse(raw) as { items: InventoryItem[] }).items;
    const found = saved.find((i) => i.id === targetId);
    expect(found?.barcodes).toContain("UPDATED-BC");
  });

  it("silently ignores AsyncStorage errors", async () => {
    mockGetItem.mockRejectedValue(new Error("io error"));
    await expect(upsertItemInBarcodeCache(makeItem(1))).resolves.toBeUndefined();
  });
});

// ── replaceBarcodeCacheWithServerItems ────────────────────────────────────────

describe("replaceBarcodeCacheWithServerItems", () => {
  it("writes exactly one key (FUSE_CACHE_KEY) as a single envelope — not two keys", async () => {
    const items = [makeItem(1, ["A"]), makeItem(2, ["B"])];
    await replaceBarcodeCacheWithServerItems(items);

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [key] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(FUSE_CACHE_KEY);
  });

  it("embeds the full item list inside the envelope", async () => {
    const items = [makeItem(1, ["A"]), makeItem(2, ["B"])];
    await replaceBarcodeCacheWithServerItems(items);

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const envelope = JSON.parse(raw) as { items: InventoryItem[]; syncedAt: number };
    const ids = envelope.items.map((i) => i.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  it("embeds a numeric syncedAt timestamp in the envelope", async () => {
    const before = Date.now();
    await replaceBarcodeCacheWithServerItems([makeItem(1)]);
    const after = Date.now();

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const envelope = JSON.parse(raw) as { items: InventoryItem[]; syncedAt: number };
    expect(typeof envelope.syncedAt).toBe("number");
    expect(envelope.syncedAt).toBeGreaterThanOrEqual(before);
    expect(envelope.syncedAt).toBeLessThanOrEqual(after);
  });

  it("prunes deleted items: items absent from the server list are not written to cache", async () => {
    const liveItems = [makeItem(1, ["KEEP-1"]), makeItem(3, ["KEEP-3"])];
    await replaceBarcodeCacheWithServerItems(liveItems);

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const envelope = JSON.parse(raw) as { items: InventoryItem[] };
    const ids = envelope.items.map((i) => i.id);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2); // item 2 was deleted — must not appear
  });

  it("writes an empty items array when no items are live", async () => {
    await replaceBarcodeCacheWithServerItems([]);

    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    const envelope = JSON.parse(raw) as { items: InventoryItem[] };
    expect(envelope.items).toEqual([]);
  });

  it("does not throw when AsyncStorage.setItem rejects", async () => {
    mockSetItem.mockRejectedValueOnce(new Error("storage full"));
    await expect(replaceBarcodeCacheWithServerItems([makeItem(1)])).resolves.toBeUndefined();
  });
});

// ── getFuseCacheSyncedAt ──────────────────────────────────────────────────────

describe("getFuseCacheSyncedAt", () => {
  it("returns the syncedAt from the cache envelope", async () => {
    const ts = 1_700_000_000_000;
    const item = makeItem(1);
    mockGetItem.mockImplementation((key) =>
      key === FUSE_CACHE_KEY
        ? Promise.resolve(envelopeWith([item], ts))
        : Promise.resolve(null),
    );

    expect(await getFuseCacheSyncedAt()).toBe(ts);
  });

  it("falls back to legacy FUSE_CACHE_SYNCED_AT_KEY when cache is in plain-array format", async () => {
    const ts = 1_700_000_000_000;
    const item = makeItem(1);
    mockGetItem.mockImplementation((key) => {
      if (key === FUSE_CACHE_KEY) return Promise.resolve(legacyArrayWith([item]));
      if (key === FUSE_CACHE_SYNCED_AT_KEY) return Promise.resolve(String(ts));
      return Promise.resolve(null);
    });

    expect(await getFuseCacheSyncedAt()).toBe(ts);
  });

  it("returns null when the cache key is not set", async () => {
    mockGetItem.mockResolvedValue(null);
    expect(await getFuseCacheSyncedAt()).toBeNull();
  });

  it("returns null when the envelope has a non-numeric syncedAt", async () => {
    mockGetItem.mockImplementation((key) =>
      key === FUSE_CACHE_KEY
        ? Promise.resolve(JSON.stringify({ items: [], syncedAt: "not-a-number" }))
        : Promise.resolve(null),
    );
    expect(await getFuseCacheSyncedAt()).toBeNull();
  });

  it("returns null when the cache is corrupt (not parseable JSON)", async () => {
    mockGetItem.mockResolvedValue("not-valid-json{{");
    expect(await getFuseCacheSyncedAt()).toBeNull();
  });

  it("returns null when AsyncStorage throws", async () => {
    mockGetItem.mockRejectedValue(new Error("disk full"));
    expect(await getFuseCacheSyncedAt()).toBeNull();
  });
});
