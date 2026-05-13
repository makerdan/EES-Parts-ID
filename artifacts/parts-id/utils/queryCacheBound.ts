/**
 * LRU eviction for the search-result query cache stored in AsyncStorage.
 * Bounded by entry count so a long session of unique searches cannot grow
 * the cache without limit.
 */
export const QUERY_CACHE_MAX_ENTRIES = 100;

export type CacheEntryWithTimestamp = { timestamp: number };

export function evictLRU<E extends CacheEntryWithTimestamp>(
  cache: Record<string, E>,
  maxEntries: number = QUERY_CACHE_MAX_ENTRIES,
): Record<string, E> {
  const keys = Object.keys(cache);
  if (keys.length <= maxEntries) return cache;
  // Sort by timestamp descending — newest first — keep the top `maxEntries`.
  const sorted = keys
    .map(k => [k, cache[k]!.timestamp] as const)
    .sort((a, b) => b[1] - a[1]);
  const out: Record<string, E> = {};
  for (let i = 0; i < maxEntries; i++) {
    const [k] = sorted[i]!;
    out[k] = cache[k]!;
  }
  return out;
}
