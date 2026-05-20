import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InventoryItem } from "@workspace/api-client-react";

export const FUSE_CACHE_KEY = "parts_id_fuse_cache_v2";

// Stores the unix timestamp (ms) of the last successful full inventory sync.
// Used to detect stale caches so deleted items are periodically pruned.
export const FUSE_CACHE_SYNCED_AT_KEY = "parts_id_fuse_cache_synced_at";

// Maximum age for the offline cache before it is considered stale. A stale
// cache may contain items that were deleted server-side since the last sync.
// Exported so barcode and search screens can show a consistent staleness warning.
export const FUSE_SYNC_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

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
    const items = JSON.parse(raw) as InventoryItem[];
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
    const items: InventoryItem[] = raw ? (JSON.parse(raw) as InventoryItem[]) : [];
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
  } catch {
    // Non-fatal: cache update failure should not surface to the user
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
