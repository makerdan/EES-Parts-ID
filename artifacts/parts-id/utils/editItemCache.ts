/**
 * Post-save cache invalidation helpers for the Edit Part screen.
 *
 * Extracted from handleSave in edit-item.tsx so the logic can be tested
 * independently without mounting the full screen.
 */

import { QUERY_CACHE_KEY, evictItemFromQueryCache } from "@/utils/searchHelpers";
import type { QueryCache } from "@/utils/searchHelpers";
import type { SearchResult } from "@workspace/api-client-react";
import { getListInventoryQueryKey } from "@workspace/api-client-react";

export type AsyncStorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type QueryClientLike = {
  invalidateQueries(
    arg:
      | { queryKey: string[] }
      | { predicate: (q: { queryKey: unknown }) => boolean },
  ): Promise<void>;
};

/**
 * Invalidate the React Query searchInventory cache and evict the edited item
 * from the AsyncStorage offline-search cache.
 *
 * Called by handleSave after all PATCH requests have resolved successfully.
 * The AsyncStorage eviction is non-fatal: an error there is swallowed so that
 * a storage failure never blocks the user from navigating away.
 */
export async function invalidateSearchAndEvictItem(opts: {
  queryClient: QueryClientLike;
  asyncStorage: AsyncStorageLike;
  itemId: number;
}): Promise<void> {
  await opts.queryClient.invalidateQueries({ queryKey: ["searchInventory"] });

  try {
    const raw = await opts.asyncStorage.getItem(QUERY_CACHE_KEY);
    if (raw) {
      const cache = JSON.parse(raw) as QueryCache<SearchResult>;
      const { pruned, changed } = evictItemFromQueryCache(cache, opts.itemId);
      if (changed) {
        await opts.asyncStorage.setItem(QUERY_CACHE_KEY, JSON.stringify(pruned));
      }
    }
  } catch {
    // Non-fatal — worst case the search cache TTL will expire naturally
  }
}

/**
 * Invalidate all paginated list cache entries for the inventory list screen.
 *
 * Uses a predicate on getListInventoryQueryKey()[0] so that every page of the
 * list (e.g. { page: 1, limit: 50 }, { page: 2, limit: 50 }, …) is cleared in
 * a single call.  Shared by BinEditor, BarcodeEditor, BulkShelfAssign, and
 * ShelfCatalogEntry so the predicate is defined and tested in one place.
 */
export async function invalidateListCache(opts: {
  queryClient: QueryClientLike;
}): Promise<void> {
  const listKeyPrefix = getListInventoryQueryKey()[0];
  await opts.queryClient.invalidateQueries({
    predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
  });
}

/**
 * Invalidate ALL React Query caches that may show stale data after an edit:
 *   1. The paginated list cache (predicate on getListInventoryQueryKey()[0])
 *   2. The full-text search cache + the AsyncStorage offline copy (via
 *      invalidateSearchAndEvictItem)
 *
 * Called by handleSave in edit-item.tsx after all PATCH requests succeed.
 * Keeping both invalidations in one place makes it straightforward to test
 * that neither path is accidentally dropped by a future refactor.
 */
export async function invalidateAllCachesAfterSave(opts: {
  queryClient: QueryClientLike;
  asyncStorage: AsyncStorageLike;
  itemId: number;
}): Promise<void> {
  await invalidateListCache(opts);
  await invalidateSearchAndEvictItem(opts);
}
