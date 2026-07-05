import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InventoryItem } from "@workspace/api-client-react";

import { reportStorageError } from "@/utils/storageErrorReporter";

export const FUSE_CACHE_KEY = "parts_id_fuse_cache_v2";

// Stores the unix timestamp (ms) of the last successful full inventory sync.
// Used to detect stale caches so deleted items are periodically pruned.
export const FUSE_CACHE_SYNCED_AT_KEY = "parts_id_fuse_cache_synced_at";

// Maximum age for the offline cache before it is considered stale. A stale
// cache may contain items that were deleted server-side since the last sync.
// Exported so barcode and search screens can show a consistent staleness warning.
export const FUSE_SYNC_MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72 hours (3 days)

// Age threshold for a "soft-stale" indicator — subtly flags that the index is
// aging but still within the hard-warning window. At this age a background
// sync is also triggered on foreground resume.
export const FUSE_SOFT_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Hard cap on the number of items stored in the offline cache. Items merged
// from individual search results could accumulate indefinitely without a bound.
// On a full sync the cache is replaced entirely, so this cap mainly guards the
// incremental merge paths between syncs.
export const MAX_FUSE_CACHE_ITEMS = 5000;

export async function lookupByBarcodeOffline(
  code: string,
): Promise<InventoryItem | null> {
  try {
    const raw = await AsyncStorage.getItem(FUSE_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((i: unknown) => typeof (i as { id?: unknown })?.id === 'number')) return null;
    const items = parsed as Array<InventoryItem>;
    const match = items.find(
      (item) => Array.isArray(item.barcodes) && item.barcodes.includes(code),
    );
    return match ?? null;
  } catch {
    return null;
  }
}

export async function upsertItemInBarcodeCache(
  updatedItem: InventoryItem,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(FUSE_CACHE_KEY);
    let items: Array<InventoryItem> = [];
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((i: unknown) => typeof (i as { id?: unknown })?.id === 'number')) {
        items = parsed as Array<InventoryItem>;
      }
    }
    const idx = items.findIndex((item) => item.id === updatedItem.id);
    if (idx >= 0) {
      // Always update an existing entry — no size check needed.
      items[idx] = updatedItem;
    } else {
      // Append only when below the item cap to prevent unbounded growth.
      // On the next full sync the cache is replaced with the authoritative
      // server list, which also resets capacity.
      if (items.length >= MAX_FUSE_CACHE_ITEMS) return;
      items.push(updatedItem);
    }
    await AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items));
  } catch (err) {
    reportStorageError("Could not update offline barcode cache", err);
  }
}

/**
 * Replace the offline barcode cache with the authoritative server item list and
 * record the sync timestamp. This is the canonical "full sync" write: any item
 * that existed in the cache but is absent from `items` is silently dropped,
 * which prunes ghost entries for inventory that has been deleted server-side.
 *
 * On native, both the item cache and the sync timestamp are written atomically
 * (sequentially). On failure the error is reported via `reportStorageError` so
 * the user sees a non-blocking toast rather than a silent failure.
 */
export async function replaceBarcodeCacheWithServerItems(
  items: Array<InventoryItem>,
): Promise<void> {
  try {
    await AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items));
    await AsyncStorage.setItem(FUSE_CACHE_SYNCED_AT_KEY, String(Date.now()));
  } catch (err) {
    reportStorageError("Could not replace offline barcode cache", err);
  }
}

/**
 * Returns the unix timestamp (ms) of the last successful full sync, or null
 * if no sync has been recorded (cache was seeded before timestamp tracking).
 */
export async function getFuseCacheSyncedAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(FUSE_CACHE_SYNCED_AT_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
