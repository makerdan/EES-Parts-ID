/**
 * Pure utility functions shared between the Search screen and its tests.
 * Extracted here so they can be imported in a `testEnvironment: "node"` context
 * without pulling in React Native or Expo modules.
 *
 * NOTE: `import type` is erased at compile time — FilterPanel.tsx is never
 * executed during unit tests.
 */
import type { FilterValues } from "@/components/FilterPanel";

export const QUERY_CACHE_KEY = "parts_id_query_cache_v1";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type QueryCacheEntry<R = unknown> = { timestamp: number; results: R[] };
export type QueryCache<R = unknown> = Record<string, QueryCacheEntry<R>>;

export function buildSearchBody(f: FilterValues, categorySlug?: string | null) {
  const minLengthNum = f.minLength.trim() !== "" ? parseFloat(f.minLength) : null;
  const maxLengthNum = f.maxLength.trim() !== "" ? parseFloat(f.maxLength) : null;
  const minWidthNum = f.minWidth.trim() !== "" ? parseFloat(f.minWidth) : null;
  const maxWidthNum = f.maxWidth.trim() !== "" ? parseFloat(f.maxWidth) : null;
  const minHeightNum = f.minHeight.trim() !== "" ? parseFloat(f.minHeight) : null;
  const maxHeightNum = f.maxHeight.trim() !== "" ? parseFloat(f.maxHeight) : null;
  const minDiameterNum = f.minDiameter.trim() !== "" ? parseFloat(f.minDiameter) : null;
  const maxDiameterNum = f.maxDiameter.trim() !== "" ? parseFloat(f.maxDiameter) : null;
  return {
    keywords: f.keywords,
    catalog: f.catalog,
    vendor: f.vendor,
    color: f.color,
    size: f.size,
    material: f.material,
    textNumbers: f.textNumbers,
    confidenceThreshold: f.confidenceThreshold,
    category: f.category,
    amperage: f.amperage,
    colorChip: f.colorChip,
    manufacturer: f.manufacturer,
    sizeChip: f.sizeChip,
    rating: f.rating,
    wireType: f.wireType,
    wireGauge: f.wireGauge,
    conduitType: f.conduitType,
    conduitSize: f.conduitSize,
    boxType: f.boxType,
    boxGangCount: f.boxGangCount,
    mountingType: f.mountingType,
    environment: f.environment,
    voltage: f.voltage,
    poleCount: f.poleCount,
    ...(minLengthNum != null && !isNaN(minLengthNum) ? { minLength: minLengthNum } : {}),
    ...(maxLengthNum != null && !isNaN(maxLengthNum) ? { maxLength: maxLengthNum } : {}),
    ...(minWidthNum != null && !isNaN(minWidthNum) ? { minWidth: minWidthNum } : {}),
    ...(maxWidthNum != null && !isNaN(maxWidthNum) ? { maxWidth: maxWidthNum } : {}),
    ...(minHeightNum != null && !isNaN(minHeightNum) ? { minHeight: minHeightNum } : {}),
    ...(maxHeightNum != null && !isNaN(maxHeightNum) ? { maxHeight: maxHeightNum } : {}),
    ...(minDiameterNum != null && !isNaN(minDiameterNum) ? { minDiameter: minDiameterNum } : {}),
    ...(maxDiameterNum != null && !isNaN(maxDiameterNum) ? { maxDiameter: maxDiameterNum } : {}),
    ...(categorySlug ? { categorySlug } : {}),
  };
}

export function buildQueryKey(f: FilterValues): string {
  return JSON.stringify(buildSearchBody(f));
}

export function pruneExpired<R>(
  cache: QueryCache<R>,
  ttlMs = CACHE_TTL_MS,
): QueryCache<R> {
  const now = Date.now();
  const out: QueryCache<R> = {};
  for (const [k, v] of Object.entries(cache)) {
    if (now - v.timestamp < ttlMs) out[k] = v;
  }
  return out;
}

export function formatStaleCacheWarning(syncedAt: number | null): string {
  if (syncedAt == null) return "Data may be outdated — sync time unknown";
  const diffMs = Date.now() - syncedAt;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days < 1) return "Data may be outdated — last synced today";
  if (days === 1) return "Data may be outdated — last synced 1 day ago";
  return `Data may be outdated — last synced ${days} days ago`;
}

export function formatRelativeAge(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Last updated just now";
  if (mins < 60) return `Last updated ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Last updated ${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `Last updated ${days} day${days === 1 ? "" : "s"} ago`;
}

// ── Offline fallback resolution ───────────────────────────────────────────────

export type OfflineFallbackResult<R = unknown> =
  /** A previous result for this exact query key was found in the TTL-pruned cache. */
  | { cacheType: "exact"; results: R[] }
  /** No exact cache match — results come from the local Fuse full-text index. */
  | { cacheType: "fuse"; results: R[] };

/**
 * Determine which offline result source to use for the given query.
 *
 * @param queryKey   The cache key for the current filter set (from buildQueryKey).
 * @param cache      The already-TTL-pruned query cache.
 * @param fuseSearch Synchronous Fuse.js search function; receives the combined
 *                   keyword string and returns matching items.
 * @param keywords   Space-joined keyword string passed to fuseSearch when there
 *                   is no exact cache match.
 */
export function resolveOfflineFallback<R>(opts: {
  queryKey: string;
  cache: QueryCache<R>;
  fuseSearch: (kw: string) => R[];
  keywords: string;
}): OfflineFallbackResult<R> {
  const exactEntry = opts.cache[opts.queryKey];
  if (exactEntry) {
    return { cacheType: "exact", results: exactEntry.results };
  }
  const fuseHits = opts.fuseSearch(opts.keywords);
  return { cacheType: "fuse", results: fuseHits };
}

// ── 3-tier search pipeline ────────────────────────────────────────────────────

export type SearchTier = "remote" | "exact" | "fuse";
export type SearchPipelineResult<R> = {
  tier: SearchTier;
  results: R[];
};

/**
 * Execute the full 3-tier search pipeline:
 *   1. Remote  — call the API via `searchFn`; on success return results
 *   2. Exact   — if the remote call fails, try an exact cache entry
 *   3. Fuse    — if there is no cache entry, fall back to the local Fuse index
 *
 * The caller is responsible for pruning the cache before passing it in.
 */
export async function runSearchPipeline<R>(opts: {
  searchFn: () => Promise<R[]>;
  queryKey: string;
  cache: QueryCache<R>;
  fuseSearch: (kw: string) => R[];
  keywords: string;
}): Promise<SearchPipelineResult<R>> {
  try {
    const results = await opts.searchFn();
    return { tier: "remote", results };
  } catch {
    const fallback = resolveOfflineFallback({
      queryKey: opts.queryKey,
      cache: opts.cache,
      fuseSearch: opts.fuseSearch,
      keywords: opts.keywords,
    });
    return { tier: fallback.cacheType, results: fallback.results };
  }
}

// ── Background inventory sync ─────────────────────────────────────────────────

export type PageFetcher<T> = (
  page: number,
  pageSize: number,
) => Promise<{ items: T[]; total: number }>;

/**
 * Fetch all pages of inventory from the server, returning the combined list.
 *
 * Stops early if a page returns zero items (guards against an infinite loop
 * when the server's reported total is inconsistent).
 *
 * @param fetchPage  Async function that fetches a single page; receives the
 *                   1-based page number and page size and must return
 *                   `{ items, total }`.
 * @param pageSize   Number of items per page (default 500).
 * @param onProgress Optional callback invoked after each page with
 *                   `(loadedSoFar, total)`.
 */
export async function fetchInventoryPages<T>(
  fetchPage: PageFetcher<T>,
  pageSize = 500,
  onProgress?: (loaded: number, total: number) => void,
): Promise<T[]> {
  let page = 1;
  let total = 0;
  const allItems: T[] = [];
  do {
    const data = await fetchPage(page, pageSize);
    if (data.items.length === 0) break;
    total = data.total;
    allItems.push(...data.items);
    onProgress?.(allItems.length, total);
    page++;
  } while (allItems.length < total);
  return allItems;
}
