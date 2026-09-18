/**
 * @jest-environment node
 *
 * Integration-style tests for the offline search-fallback and background
 * inventory-sync utilities extracted from SearchScreen.
 *
 * Covered scenarios
 * ─────────────────
 * resolveOfflineFallback (3-tier search fallback, tiers 2 and 3)
 *   1. Exact cache hit → cacheType "exact", returns cached results
 *   2. No cache entry → Fuse fallback called with combined keyword string
 *   3. Cache miss AND Fuse returns results → cacheType "fuse"
 *   4. Cache miss AND Fuse returns empty → cacheType "fuse", results []
 *   5. Expired entries are NOT matched (pruneExpired already applied by caller)
 *   6. Multiple chip dimensions are combined into the keyword string correctly
 *
 * fetchInventoryPages (background cache refresh)
 *   7. Single page (total ≤ pageSize) — one fetch, correct item list
 *   8. Multiple pages — all pages fetched and items concatenated
 *   9. Zero-items guard — stops immediately if first page returns 0 items
 *  10. Partial last page — stops when allItems.length >= total
 *  11. onProgress callback receives correct loaded/total values
 *  12. Propagates fetch errors to caller
 */

import {
  resolveOfflineFallback,
  fetchInventoryPages,
  runSearchPipeline,
  buildQueryKey,
  pruneExpired,
  CACHE_TTL_MS,
} from "../utils/searchHelpers";
import type { QueryCache } from "../utils/searchHelpers";

// ── FilterValues stub (mirrors the real interface) ────────────────────────────
type FilterValues = {
  keywords: string; catalog: string; vendor: string; color: string; size: string;
  material: string; textNumbers: string; confidenceThreshold: number;
  minLength: string; maxLength: string;
  minWidth: string; maxWidth: string;
  minHeight: string; maxHeight: string;
  minDiameter: string; maxDiameter: string; minWeight: string; maxWeight: string;
  includeNullDimensions: boolean;
  category: string; amperage: string; colorChip: string; manufacturer: string;
  sizeChip: string; rating: string; wireType: string; wireGauge: string;
  conduitType: string; conduitSize: string; boxType: string; boxGangCount: string;
  mountingType: string; environment: string; voltage: string; poleCount: string;
};

const BLANK: FilterValues = {
  keywords: "", catalog: "", vendor: "", color: "", size: "", material: "",
  textNumbers: "", confidenceThreshold: 50, minLength: "", maxLength: "",
  minWidth: "", maxWidth: "", minHeight: "", maxHeight: "",
  minDiameter: "", maxDiameter: "", minWeight: "", maxWeight: "",
  includeNullDimensions: false,
  category: "", amperage: "",
  colorChip: "", manufacturer: "", sizeChip: "", rating: "", wireType: "",
  wireGauge: "", conduitType: "", conduitSize: "", boxType: "", boxGangCount: "",
  mountingType: "", environment: "", voltage: "", poleCount: "",
};

type MockResult = { id: number; label: string };

function makeCache(
  queryKey: string,
  results: MockResult[],
  ageMs = 0,
): QueryCache<MockResult> {
  return {
    [queryKey]: { timestamp: Date.now() - ageMs, results },
  };
}

// ── resolveOfflineFallback ────────────────────────────────────────────────────

describe("resolveOfflineFallback — 3-tier search fallback (tiers 2 & 3)", () => {
  it("returns cacheType 'exact' when the query key matches a cache entry", () => {
    const f: FilterValues = { ...BLANK, keywords: "breaker" };
    const queryKey = buildQueryKey(f);
    const cachedResults: MockResult[] = [{ id: 1, label: "Breaker A" }];
    const cache = makeCache(queryKey, cachedResults);

    const result = resolveOfflineFallback({
      queryKey,
      cache,
      fuseSearch: jest.fn(),
      keywords: "breaker",
    });

    expect(result.cacheType).toBe("exact");
    expect(result.results).toEqual(cachedResults);
  });

  it("does NOT call fuseSearch when there is an exact cache hit", () => {
    const f: FilterValues = { ...BLANK, keywords: "wire" };
    const queryKey = buildQueryKey(f);
    const cache = makeCache(queryKey, [{ id: 2, label: "Wire B" }]);
    const fuseSearch = jest.fn().mockReturnValue([]);

    resolveOfflineFallback({ queryKey, cache, fuseSearch, keywords: "wire" });

    expect(fuseSearch).not.toHaveBeenCalled();
  });

  it("falls through to Fuse when there is no exact cache entry", () => {
    const f: FilterValues = { ...BLANK, keywords: "conduit" };
    const queryKey = buildQueryKey(f);
    const fuseResults: MockResult[] = [{ id: 3, label: "Conduit C" }];
    const fuseSearch = jest.fn().mockReturnValue(fuseResults);

    const result = resolveOfflineFallback({
      queryKey,
      cache: {}, // empty cache
      fuseSearch,
      keywords: "conduit",
    });

    expect(result.cacheType).toBe("fuse");
    expect(result.results).toEqual(fuseResults);
    expect(fuseSearch).toHaveBeenCalledWith("conduit");
  });

  it("returns cacheType 'fuse' with empty results when Fuse finds nothing", () => {
    const f: FilterValues = { ...BLANK, keywords: "unobtainium" };
    const queryKey = buildQueryKey(f);
    const fuseSearch = jest.fn().mockReturnValue([]);

    const result = resolveOfflineFallback({
      queryKey,
      cache: {},
      fuseSearch,
      keywords: "unobtainium",
    });

    expect(result.cacheType).toBe("fuse");
    expect(result.results).toEqual([]);
  });

  it("does not match a different query key in the cache", () => {
    const f1: FilterValues = { ...BLANK, keywords: "switch" };
    const f2: FilterValues = { ...BLANK, keywords: "relay" };
    const cachedKey = buildQueryKey(f1);
    const lookupKey = buildQueryKey(f2);
    const fuseSearch = jest.fn().mockReturnValue([]);
    const cache = makeCache(cachedKey, [{ id: 5, label: "Switch D" }]);

    const result = resolveOfflineFallback({
      queryKey: lookupKey,
      cache,
      fuseSearch,
      keywords: "relay",
    });

    expect(result.cacheType).toBe("fuse");
    expect(fuseSearch).toHaveBeenCalled();
  });

  it("passes the joined chip-dimension keywords to fuseSearch", () => {
    const f: FilterValues = {
      ...BLANK,
      keywords: "breaker",
      category: "Breaker",
      voltage: "240V",
      amperage: "20A",
    };
    const queryKey = buildQueryKey(f);
    const fuseSearch = jest.fn().mockReturnValue([]);

    resolveOfflineFallback({
      queryKey,
      cache: {},
      fuseSearch,
      // The caller joins the relevant fields before calling resolveOfflineFallback
      keywords: [f.keywords, f.catalog, f.vendor, f.category, f.voltage, f.amperage]
        .filter(Boolean).join(" "),
    });

    const calledWith: string = fuseSearch.mock.calls[0][0] as string;
    expect(calledWith).toContain("breaker");
    expect(calledWith).toContain("Breaker");
    expect(calledWith).toContain("240V");
    expect(calledWith).toContain("20A");
  });

  it("treats a TTL-expired entry as a cache miss (caller should prune first)", () => {
    // Simulate that the caller has already pruned; expired entries are absent
    const f: FilterValues = { ...BLANK, keywords: "fuse" };
    const queryKey = buildQueryKey(f);
    // Build a raw cache with an expired entry
    const rawCache: QueryCache<MockResult> = {
      [queryKey]: { timestamp: 0, results: [{ id: 9, label: "Old Fuse" }] },
    };
    // Prune it — mirrors what runOfflineFallback does before calling this fn
    const pruned = pruneExpired<MockResult>(rawCache);
    const fuseSearch = jest.fn().mockReturnValue([]);

    const result = resolveOfflineFallback({
      queryKey,
      cache: pruned,
      fuseSearch,
      keywords: "fuse",
    });

    // The expired entry should not be visible after pruning
    expect(result.cacheType).toBe("fuse");
    expect(fuseSearch).toHaveBeenCalled();
  });
});

// ── fetchInventoryPages ───────────────────────────────────────────────────────

describe("fetchInventoryPages — background cache refresh", () => {
  type Item = { id: number };

  it("returns all items from a single page", async () => {
    const items: Item[] = [{ id: 1 }, { id: 2 }];
    const fetchPage = jest.fn().mockResolvedValue({ items, total: 2 });

    const result = await fetchInventoryPages(fetchPage);

    expect(result).toEqual(items);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(1, 500);
  });

  it("fetches multiple pages and concatenates items", async () => {
    const page1: Item[] = [{ id: 1 }, { id: 2 }];
    const page2: Item[] = [{ id: 3 }];
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce({ items: page1, total: 3 })
      .mockResolvedValueOnce({ items: page2, total: 3 });

    const result = await fetchInventoryPages(fetchPage, 2);

    expect(result).toEqual([...page1, ...page2]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 1, 2);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2, 2);
  });

  it("stops immediately when the first page returns zero items (total mismatch guard)", async () => {
    const fetchPage = jest.fn().mockResolvedValue({ items: [], total: 999 });

    const result = await fetchInventoryPages(fetchPage);

    expect(result).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops once allItems.length >= total (handles partial last page)", async () => {
    // total=5 but last page only has 2 items — loop should stop after page 3
    const page1: Item[] = [{ id: 1 }, { id: 2 }];
    const page2: Item[] = [{ id: 3 }, { id: 4 }];
    const page3: Item[] = [{ id: 5 }];
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce({ items: page1, total: 5 })
      .mockResolvedValueOnce({ items: page2, total: 5 })
      .mockResolvedValueOnce({ items: page3, total: 5 });

    const result = await fetchInventoryPages(fetchPage, 2);

    expect(result).toHaveLength(5);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("invokes onProgress after each page with the running total", async () => {
    const page1: Item[] = [{ id: 1 }, { id: 2 }];
    const page2: Item[] = [{ id: 3 }];
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce({ items: page1, total: 3 })
      .mockResolvedValueOnce({ items: page2, total: 3 });
    const onProgress = jest.fn();

    await fetchInventoryPages(fetchPage, 2, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 2, 3); // after page 1: 2 loaded, total 3
    expect(onProgress).toHaveBeenNthCalledWith(2, 3, 3); // after page 2: 3 loaded, total 3
  });

  it("propagates errors thrown by fetchPage", async () => {
    const fetchPage = jest.fn().mockRejectedValue(new Error("Sync failed: 503"));

    await expect(fetchInventoryPages(fetchPage)).rejects.toThrow("Sync failed: 503");
  });

  it("works correctly when no onProgress callback is supplied", async () => {
    const items: Item[] = [{ id: 1 }];
    const fetchPage = jest.fn().mockResolvedValue({ items, total: 1 });

    await expect(fetchInventoryPages(fetchPage)).resolves.toEqual(items);
  });
});

// ── runSearchPipeline — end-to-end 3-tier sequence ───────────────────────────

describe("runSearchPipeline — full 3-tier search sequence", () => {
  type MockResult = { id: number };

  const BLANK: FilterValues = {
    keywords: "", catalog: "", vendor: "", color: "", size: "", material: "",
    textNumbers: "", confidenceThreshold: 50, minLength: "", maxLength: "",
    minWidth: "", maxWidth: "", minHeight: "", maxHeight: "",
    minDiameter: "", maxDiameter: "", minWeight: "", maxWeight: "",
    includeNullDimensions: false,
    category: "", amperage: "",
    colorChip: "", manufacturer: "", sizeChip: "", rating: "", wireType: "",
    wireGauge: "", conduitType: "", conduitSize: "", boxType: "", boxGangCount: "",
    mountingType: "", environment: "", voltage: "", poleCount: "",
  };

  it("tier 1 (remote success) — returns remote results without touching cache or Fuse", async () => {
    const remoteResults: MockResult[] = [{ id: 1 }, { id: 2 }];
    const searchFn = jest.fn().mockResolvedValue(remoteResults);
    const fuseSearch = jest.fn().mockReturnValue([{ id: 99 }]);
    const queryKey = buildQueryKey(BLANK);

    const result = await runSearchPipeline({
      searchFn,
      queryKey,
      cache: {},
      fuseSearch,
      keywords: "",
    });

    expect(result.tier).toBe("remote");
    expect(result.results).toEqual(remoteResults);
    expect(fuseSearch).not.toHaveBeenCalled();
  });

  it("tier 2 (remote failure + exact cache hit) — returns cached results", async () => {
    const searchFn = jest.fn().mockRejectedValue(new Error("network error"));
    const cachedResults: MockResult[] = [{ id: 3 }, { id: 4 }];
    const f: FilterValues = { ...BLANK, keywords: "wire" };
    const queryKey = buildQueryKey(f);
    const cache: QueryCache<MockResult> = {
      [queryKey]: { timestamp: Date.now(), results: cachedResults },
    };
    const fuseSearch = jest.fn().mockReturnValue([]);

    const result = await runSearchPipeline({
      searchFn,
      queryKey,
      cache,
      fuseSearch,
      keywords: "wire",
    });

    expect(result.tier).toBe("exact");
    expect(result.results).toEqual(cachedResults);
    expect(fuseSearch).not.toHaveBeenCalled();
  });

  it("tier 3 (remote failure + cache miss) — returns Fuse results", async () => {
    const searchFn = jest.fn().mockRejectedValue(new Error("timeout"));
    const fuseResults: MockResult[] = [{ id: 5 }];
    const f: FilterValues = { ...BLANK, keywords: "conduit" };
    const queryKey = buildQueryKey(f);
    const fuseSearch = jest.fn().mockReturnValue(fuseResults);

    const result = await runSearchPipeline({
      searchFn,
      queryKey,
      cache: {}, // no cache
      fuseSearch,
      keywords: "conduit",
    });

    expect(result.tier).toBe("fuse");
    expect(result.results).toEqual(fuseResults);
    expect(fuseSearch).toHaveBeenCalledWith("conduit");
  });

  it("tier 3 fallback — returns empty results when both cache and Fuse miss", async () => {
    const searchFn = jest.fn().mockRejectedValue(new Error("offline"));
    const fuseSearch = jest.fn().mockReturnValue([]);
    const f: FilterValues = { ...BLANK, keywords: "unobtainium" };
    const queryKey = buildQueryKey(f);

    const result = await runSearchPipeline({
      searchFn,
      queryKey,
      cache: {},
      fuseSearch,
      keywords: "unobtainium",
    });

    expect(result.tier).toBe("fuse");
    expect(result.results).toEqual([]);
  });

  it("cache with a different query key is not used (wrong key → falls to Fuse)", async () => {
    const searchFn = jest.fn().mockRejectedValue(new Error("offline"));
    const cachedResults: MockResult[] = [{ id: 7 }];
    const wrongKey = buildQueryKey({ ...BLANK, keywords: "relay" });
    const lookupKey = buildQueryKey({ ...BLANK, keywords: "switch" });
    const fuseResults: MockResult[] = [{ id: 8 }];
    const cache: QueryCache<MockResult> = {
      [wrongKey]: { timestamp: Date.now(), results: cachedResults },
    };
    const fuseSearch = jest.fn().mockReturnValue(fuseResults);

    const result = await runSearchPipeline({
      searchFn,
      queryKey: lookupKey,
      cache,
      fuseSearch,
      keywords: "switch",
    });

    expect(result.tier).toBe("fuse");
    expect(result.results).toEqual(fuseResults);
  });

  it("remote success supersedes a populated cache entry", async () => {
    const remoteResults: MockResult[] = [{ id: 10 }];
    const cachedResults: MockResult[] = [{ id: 11 }]; // stale
    const f: FilterValues = { ...BLANK, keywords: "breaker" };
    const queryKey = buildQueryKey(f);
    const cache: QueryCache<MockResult> = {
      [queryKey]: { timestamp: Date.now(), results: cachedResults },
    };
    const searchFn = jest.fn().mockResolvedValue(remoteResults);
    const fuseSearch = jest.fn();

    const result = await runSearchPipeline({
      searchFn,
      queryKey,
      cache,
      fuseSearch,
      keywords: "breaker",
    });

    expect(result.tier).toBe("remote");
    expect(result.results).toEqual(remoteResults);
    expect(fuseSearch).not.toHaveBeenCalled();
  });
});

// ── CACHE_TTL_MS sanity check ─────────────────────────────────────────────────

describe("CACHE_TTL_MS constant", () => {
  it("is 24 hours in milliseconds", () => {
    expect(CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
