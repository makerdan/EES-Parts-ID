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
