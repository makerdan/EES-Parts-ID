/**
 * Post-save cache invalidation helpers for the Edit Part screen.
 *
 * Extracted from handleSave in edit-item.tsx so the logic can be tested
 * independently without mounting the full screen.
 */

import type { InventoryItem, InventoryListResponse, SearchInventoryResponse, SearchResult } from "@workspace/api-client-react";
import { getListInventoryQueryKey } from "@workspace/api-client-react";

import { FUSE_CACHE_KEY } from "@/utils/offlineBarcode";
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

export type CacheCleanupResult = {
  failures: Array<unknown>;
  ok: boolean;
};

const cleanupResult = (failures: Array<unknown>): CacheCleanupResult => ({
  failures,
  ok: failures.length === 0,
});

function updateStoredFuseCache(raw: string, updatedItem: InventoryItem): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const index = parsed.findIndex((item) => (
      typeof item === "object" && item !== null && (item as { id?: unknown }).id === updatedItem.id
    ));
    if (index < 0) return null;
    const next = [...parsed];
    next[index] = updatedItem;
    return JSON.stringify(next);
  }

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { items?: unknown }).items)) {
    return null;
  }
  const envelope = parsed as { items: Array<unknown>; syncedAt?: unknown };
  const index = envelope.items.findIndex((item) => (
    typeof item === "object" && item !== null && (item as { id?: unknown }).id === updatedItem.id
  ));
  if (index < 0) return null;
  const nextItems = [...envelope.items];
  nextItems[index] = updatedItem;
  return JSON.stringify({ ...envelope, items: nextItems });
}

function patchItemInQueryCaches(
  queryClient: QueryClientLikeWithSetQueries,
  updatedItem: InventoryItem,
): void {
  const listKeyPrefix = getListInventoryQueryKey()[0];
  const patchItem = (item: InventoryItem): InventoryItem =>
    item.id === updatedItem.id ? { ...item, ...updatedItem } : item;

  queryClient.setQueriesData<InventoryListResponse>(
    { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
    (old) => old ? { ...old, items: old.items.map(patchItem) } : old,
  );

  queryClient.setQueriesData<SearchInventoryResponse>(
    { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
    (old) => {
      if (!old) return old;
      const patchResult = (result: SearchInventoryResponse["results"][number]) => (
        result.item.id === updatedItem.id ? { ...result, item: patchItem(result.item) } : result
      );
      return {
        ...old,
        results: old.results.map(patchResult),
        ...(old.sizeUnknownResults !== undefined
          ? { sizeUnknownResults: old.sizeUnknownResults.map(patchResult) }
          : {}),
      };
    },
  );
}

async function updateStoredFuseItem(
  asyncStorage: AsyncStorageLike,
  updatedItem: InventoryItem,
): Promise<void> {
  const raw = await asyncStorage.getItem(FUSE_CACHE_KEY);
  if (!raw) return;
  const next = updateStoredFuseCache(raw, updatedItem);
  if (next !== null) await asyncStorage.setItem(FUSE_CACHE_KEY, next);
}

/**
 * Invalidate the React Query searchInventory cache and evict the edited item
 * from the AsyncStorage offline-search cache.
 *
 * Called by handleSave after all PATCH requests have resolved successfully.
 * Cache work is non-fatal to the server write, but failures are returned so the
 * caller can distinguish "saved, refresh failed" from a rejected write.
 */
export async function invalidateSearchAndEvictItem(opts: {
  queryClient: QueryClientLike;
  asyncStorage: AsyncStorageLike;
  itemId: number;
  updatedItem?: InventoryItem;
}): Promise<CacheCleanupResult> {
  const failures: Array<unknown> = [];
  await Promise.all([
    opts.queryClient.invalidateQueries({ queryKey: ["searchInventory"] }).catch((error) => {
      failures.push(error);
    }),
    (async () => {
      try {
        const raw = await opts.asyncStorage.getItem(QUERY_CACHE_KEY);
        if (raw) {
          const cache = parseStoredQueryCache(raw);
          if (cache) {
            const { pruned, changed } = evictItemFromQueryCache(cache, opts.itemId);
            if (changed) await opts.asyncStorage.setItem(QUERY_CACHE_KEY, JSON.stringify(pruned));
          }
        }
      } catch (error) {
        failures.push(error);
      }
    })(),
    opts.updatedItem
      ? updateStoredFuseItem(opts.asyncStorage, opts.updatedItem).catch((error) => {
          failures.push(error);
        })
      : Promise.resolve(),
  ]);
  return cleanupResult(failures);
}

/**
 * Patch the in-memory list/search caches and reconcile every durable cache after
 * a successful inventory write. Cache work is deliberately non-fatal: the
 * server write has already committed, so callers can report a refresh problem
 * without telling the admin that the write failed.
 */
export async function updateItemInAllCaches(opts: {
  queryClient: QueryClientLikeWithSetQueries;
  asyncStorage: AsyncStorageLike;
  updatedItem: InventoryItem;
}): Promise<CacheCleanupResult> {
  const failures: Array<unknown> = [];
  try {
    patchItemInQueryCaches(opts.queryClient, opts.updatedItem);
  } catch (error) {
    failures.push(error);
  }

  const listResult = await invalidateListCache(opts).then(
    () => null,
    (error) => error,
  );
  if (listResult) failures.push(listResult);

  const searchResult = await invalidateSearchAndEvictItem({
    ...opts,
    itemId: opts.updatedItem.id,
  });
  failures.push(...searchResult.failures);
  return cleanupResult(failures);
}

/**
 * Invalidate all paginated list and search caches after a successful save.
 * When an updated item is provided, patch it into the active in-memory caches
 * before invalidating so the current Search card updates immediately.
 */
export async function invalidateAllCachesAfterSave(opts: {
  queryClient: QueryClientLike;
  asyncStorage: AsyncStorageLike;
  itemId: number;
  updatedItem?: InventoryItem;
}): Promise<CacheCleanupResult> {
  if (opts.updatedItem) {
    if (!("setQueriesData" in opts.queryClient)) {
      return cleanupResult([new Error("Query client cannot update item caches")]);
    }
    return updateItemInAllCaches({
      queryClient: opts.queryClient as QueryClientLikeWithSetQueries,
      asyncStorage: opts.asyncStorage,
      updatedItem: opts.updatedItem,
    });
  }

  const failures: Array<unknown> = [];
  const listResult = await invalidateListCache(opts).then(
    () => null,
    (error) => error,
  );
  if (listResult) failures.push(listResult);
  const searchResult = await invalidateSearchAndEvictItem(opts);
  failures.push(...searchResult.failures);
  return cleanupResult(failures);
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
 */
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
