/**
 * Post-save cache invalidation helpers for the Edit Part screen.
 *
 * Extracted from handleSave in edit-item.tsx so the logic can be tested
 * independently without mounting the full screen.
 */

import { QUERY_CACHE_KEY, evictItemFromQueryCache } from "@/utils/searchHelpers";
import type { QueryCache } from "@/utils/searchHelpers";
import type { SearchResult } from "@workspace/api-client-react";

export type AsyncStorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type QueryClientLike = {
  invalidateQueries(arg: { queryKey: string[] }): Promise<void>;
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
