import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InventoryItem } from "@workspace/api-client-react";

import { reportStorageError } from "@/utils/storageErrorReporter";

export const FUSE_CACHE_KEY = "parts_id_fuse_cache_v2";

// Legacy key that stored the sync timestamp separately. Kept exported so
// getFuseCacheSyncedAt can read it as a backward-compatible fallback when the
// cache was written in the old plain-array format (before the envelope migration).
// New writes no longer use this key — syncedAt is embedded in the envelope
// stored under FUSE_CACHE_KEY.
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

// ── Internal envelope helpers ─────────────────────────────────────────────────

type FuseCacheEnvelope = { items: Array<InventoryItem>; syncedAt: number | null };

function isValidItemArray(v: unknown): v is Array<InventoryItem> {
  return Array.isArray(v) && v.every((i: unknown) => typeof (i as { id?: unknown })?.id === 'number');
}

/**
 * Parse a raw AsyncStorage string into the envelope form.
 * Handles both:
 *   - New format:    { items: [...], syncedAt: number | null }
 *   - Legacy format: plain InventoryItem[] (written before the envelope migration)
 *
 * Returns null when the value is absent, corrupt, or structurally invalid.
 */
function parseCacheEnvelope(raw: string | null): FuseCacheEnvelope | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      if (!isValidItemArray(parsed)) return null;
      return { items: parsed, syncedAt: null };
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const env = parsed as { items?: unknown; syncedAt?: unknown };
      if (!isValidItemArray(env.items)) return null;
      const syncedAt =
        typeof env.syncedAt === 'number' && Number.isFinite(env.syncedAt)
          ? env.syncedAt
          : null;
      return { items: env.items, syncedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse the raw FUSE_CACHE_KEY value and return only the items array, handling
 * both the current envelope format and the legacy plain-array format.
 * Returns null when the value is absent, corrupt, or structurally invalid.
 *
 * Exported for use by callers that obtain the raw string themselves (e.g.
 * screens that also need to detect a corrupt cache for cleanup purposes).
 */
export function parseFuseCacheItems(raw: string): Array<InventoryItem> | null {
  const envelope = parseCacheEnvelope(raw);
  return envelope ? envelope.items : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function lookupByBarcodeOffline(
  code: string,
): Promise<InventoryItem | null> {
  try {
    const raw = await AsyncStorage.getItem(FUSE_CACHE_KEY);
    const envelope = parseCacheEnvelope(raw);
    if (!envelope) return null;
    const match = envelope.items.find(
      (item) => Array.isArray(item.barcodes) && item.barcodes.includes(code),
    );
    return match ?? null;
  } catch {
    return null;
  }
}

// Serialise every read→mutate→write sequence for the barcode cache through a
// single promise chain so two concurrent upsert calls cannot both read a stale
// snapshot and clobber each other's write.
let _barcodeCacheWriteLock: Promise<void> = Promise.resolve();

export async function upsertItemInBarcodeCache(
  updatedItem: InventoryItem,
): Promise<void> {
  const next = _barcodeCacheWriteLock.then(async () => {
    try {
      const raw = await AsyncStorage.getItem(FUSE_CACHE_KEY);
      const envelope = parseCacheEnvelope(raw) ?? { items: [], syncedAt: null };
      const items = [...envelope.items];
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
      await AsyncStorage.setItem(
        FUSE_CACHE_KEY,
        JSON.stringify({ items, syncedAt: envelope.syncedAt }),
      );
    } catch (err) {
      reportStorageError("Could not update offline barcode cache", err);
    }
  });
  // The shared lock must never reject — swallow errors so subsequent writes
  // are not permanently blocked by a single failed operation.
  _barcodeCacheWriteLock = next.catch(() => {});
  return next;
}

/**
 * Replace the offline barcode cache with the authoritative server item list and
 * record the sync timestamp. This is the canonical "full sync" write: any item
 * that existed in the cache but is absent from `items` is silently dropped,
 * which prunes ghost entries for inventory that has been deleted server-side.
 *
 * Both the item list and the sync timestamp are persisted as a single JSON
 * envelope under one key in one write call. A process crash cannot produce a
 * partial state where an updated item list is paired with a stale timestamp or
 * vice versa — either the entire envelope is written, or none of it is.
 */
export async function replaceBarcodeCacheWithServerItems(
  items: Array<InventoryItem>,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      FUSE_CACHE_KEY,
      JSON.stringify({ items, syncedAt: Date.now() }),
    );
  } catch (err) {
    reportStorageError("Could not replace offline barcode cache", err);
  }
}

/**
 * Returns the unix timestamp (ms) of the last successful full sync, or null
 * if no sync has been recorded (cache absent, corrupt, or predates timestamp tracking).
 *
 * Reads the sync timestamp from the cache envelope stored under FUSE_CACHE_KEY.
 * When the cache is in the legacy plain-array format (written before the envelope
 * migration), falls back to the legacy FUSE_CACHE_SYNCED_AT_KEY for the timestamp.
 */
export async function getFuseCacheSyncedAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(FUSE_CACHE_KEY);
    if (!raw) return null;
    const envelope = parseCacheEnvelope(raw);
    if (!envelope) return null;
    if (envelope.syncedAt !== null) return envelope.syncedAt;
    // Legacy plain-array format: syncedAt was stored in a separate key.
    // Check that key as a one-time migration fallback.
    const legacyRaw = await AsyncStorage.getItem(FUSE_CACHE_SYNCED_AT_KEY);
    if (!legacyRaw) return null;
    const n = Number(legacyRaw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
