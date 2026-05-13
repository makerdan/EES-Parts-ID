/**
 * @jest-environment node
 *
 * Unit tests for the LRU eviction helper used by the search-result query cache.
 * Pins the contract that:
 *   - Caches at or under the cap are returned unchanged.
 *   - Caches above the cap are trimmed to the newest `maxEntries` by timestamp.
 *   - The default cap is exposed and respected when omitted.
 */
import { evictLRU, QUERY_CACHE_MAX_ENTRIES } from "../utils/queryCacheBound";

type Entry = { timestamp: number; results: unknown[] };

function makeCache(n: number, baseTs = 1_000): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (let i = 0; i < n; i++) {
    out[`q${i}`] = { timestamp: baseTs + i, results: [] };
  }
  return out;
}

describe("evictLRU", () => {
  it("returns the cache unchanged when at or under the cap", () => {
    const cache = makeCache(5);
    const out = evictLRU(cache, 10);
    expect(Object.keys(out).sort()).toEqual(Object.keys(cache).sort());
  });

  it("evicts the oldest entries by timestamp when over the cap", () => {
    const cache = makeCache(5); // q0 (oldest) … q4 (newest)
    const out = evictLRU(cache, 3);
    const keys = Object.keys(out).sort();
    expect(keys).toEqual(["q2", "q3", "q4"]); // newest 3 kept
    expect(out.q0).toBeUndefined();
    expect(out.q1).toBeUndefined();
  });

  it("keeps exactly maxEntries entries when far over the cap", () => {
    const cache = makeCache(50);
    const out = evictLRU(cache, 10);
    expect(Object.keys(out)).toHaveLength(10);
  });

  it("uses the default cap when maxEntries is omitted", () => {
    const cache = makeCache(QUERY_CACHE_MAX_ENTRIES + 5);
    const out = evictLRU(cache);
    expect(Object.keys(out)).toHaveLength(QUERY_CACHE_MAX_ENTRIES);
  });

  it("does not mutate the input cache", () => {
    const cache = makeCache(5);
    const before = JSON.stringify(cache);
    evictLRU(cache, 2);
    expect(JSON.stringify(cache)).toBe(before);
  });

  it("preserves entry values for kept keys", () => {
    const cache: Record<string, Entry> = {
      a: { timestamp: 100, results: [1] },
      b: { timestamp: 200, results: [2] },
      c: { timestamp: 300, results: [3] },
    };
    const out = evictLRU(cache, 2);
    expect(out.b).toEqual(cache.b);
    expect(out.c).toEqual(cache.c);
    expect(out.a).toBeUndefined();
  });
});
