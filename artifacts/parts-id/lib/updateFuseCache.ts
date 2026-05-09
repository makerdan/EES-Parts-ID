/**
 * Shared helper for patching a single item in the persisted Fuse inventory
 * cache after a RecordEditModal save.
 *
 * The Search tab (index.tsx) keeps an in-memory Fuse index as well and passes
 * its already-computed items array directly to avoid the AsyncStorage round-
 * trip.  Photo ID and Scan screens have no in-memory index so they read from
 * AsyncStorage, patch, and write back.
 *
 * Callers on every screen that hosts a RecordEditModal must call this so the
 * offline Search fallback and Browse-by-Aisle both reflect edits made from
 * any part of the app without waiting for the next full sync.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { InventoryItem } from '@workspace/api-client-react';

export const FUSE_CACHE_KEY = 'parts_id_fuse_cache_v3';

/**
 * Patches `updated` in the persisted Fuse cache.
 *
 * @param updated   The item returned by the server after a successful save.
 * @param knownItems  When the caller already has the full in-memory items
 *   array (e.g. the Search tab's `fuseItemsRef.current`), pass it here to
 *   skip the AsyncStorage read.  If omitted the cache is read from
 *   AsyncStorage, patched in place, and written back.
 */
export async function updateFuseCache(
  updated: InventoryItem,
  knownItems?: InventoryItem[]
): Promise<void> {
  try {
    let items: InventoryItem[] | null = knownItems ?? null;
    if (!items) {
      const raw = await AsyncStorage.getItem(FUSE_CACHE_KEY);
      if (!raw) return;
      items = JSON.parse(raw) as InventoryItem[];
    }
    const patched = items.map((it) => (it.id === updated.id ? { ...it, ...updated } : it));
    await AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(patched));
  } catch {
    // Cache write failures are non-fatal — the next full sync will repair the state.
  }
}
