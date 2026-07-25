/**
 * Post-save cache invalidation helpers for the Edit Part screen.
 *
 * Extracted from handleSave in edit-item.tsx so the logic can be tested
 * independently without mounting the full screen.
 */

import type { InventoryListResponse, SearchInventoryResponse, SearchResult } from "@workspace/api-client-react";
import { getListInventoryQueryKey } from "@workspace/api-client-react";

import type { QueryCache } from "@/utils/searchHelpers";
import { evictItemFromQueryCache,QUERY_CACHE_KEY } from "@/utils/searchHelpers";

export type AsyncStorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

/**
 * Parse + validate a persisted offline search cache blob.
 *
 * AsyncStorage data survives app upgrades, so the stored shape may be stale.
 * Each entry must be an object with a numeric `timestamp` and an array
 * `results`; anything else (or invalid JSON) returns null so callers skip the
 * cache rather than corrupt downstream state.
 */
export function parseStoredQueryCache(raw: string): QueryCache<SearchResult> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) return null;
    const entry = value as { timestamp?: unknown; results?: unknown };
    if (typeof entry.timestamp !== "number" || !Array.isArray(entry.results)) return null;
  }
  return parsed as QueryCache<SearchResult>;
}

export type QueryClientLike = {
  invalidateQueries(
    arg:
      | { queryKey: Array<string> }
      | { predicate: (q: { queryKey: unknown }) => boolean },
  ): Promise<void>;
};

export type QueryClientLikeWithSetQueries = QueryClientLike & {
  setQueriesData<T>(
    filter: { predicate: (q: { queryKey: unknown }) => boolean },
    updater: (old: T | undefined) => T | undefined,
  ): void;
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
      const cache = parseStoredQueryCache(raw);
      if (cache) {
        const { pruned, changed } = evictItemFromQueryCache(cache, opts.itemId);
        if (changed) {
          await opts.asyncStorage.setItem(QUERY_CACHE_KEY, JSON.stringify(pruned));
        }
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

/**
 * Immediately remove a deleted item from all query caches — both the in-memory
 * TanStack Query cache and the AsyncStorage offline search cache.
 *
 * Call this from any admin delete operation's onSuccess handler so the deleted
 * item disappears from cached search results immediately on the current device
 * without requiring the user to wait for a background refetch.
 *
 * Steps:
 *   1. Synchronously filter out the item from all in-memory list + search caches.
 *   2. Evict the item from the AsyncStorage offline search cache.
 *   3. Invalidate affected query keys so a background refetch confirms the removal.
 */
export async function evictDeletedItemFromAllCaches(opts: {
  queryClient: QueryClientLikeWithSetQueries;
  asyncStorage: AsyncStorageLike;
  itemId: number;
}): Promise<void> {
  const { queryClient, asyncStorage, itemId } = opts;
  const listKeyPrefix = getListInventoryQueryKey()[0];

  queryClient.setQueriesData<InventoryListResponse>(
    { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
    (old) => {
      if (!old) return old;
      const items = old.items.filter(i => i.id !== itemId);
      const total = Math.max(0, (old.total ?? 0) - (items.length < old.items.length ? 1 : 0));
      return { ...old, items, total };
    },
  );

  queryClient.setQueriesData<SearchInventoryResponse>(
    { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
    (old) => {
      if (!old) return old;
      return {
        ...old,
        results: old.results.filter(r => r.item.id !== itemId),
        // exactOptionalPropertyTypes: only include the optional key when present
        ...(old.sizeUnknownResults !== undefined
          ? { sizeUnknownResults: old.sizeUnknownResults.filter(r => r.item.id !== itemId) }
          : {}),
      };
    },
  );

  try {
    const raw = await asyncStorage.getItem(QUERY_CACHE_KEY);
    if (raw) {
      const cache = parseStoredQueryCache(raw);
      if (cache) {
        const { pruned, changed } = evictItemFromQueryCache(cache, itemId);
        if (changed) await asyncStorage.setItem(QUERY_CACHE_KEY, JSON.stringify(pruned));
      }
    }
  } catch {
    // Non-fatal
  }

  await invalidateListCache(opts);
  await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
}
