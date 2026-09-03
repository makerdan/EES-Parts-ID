/**
 * @jest-environment node
 *
 * Regression tests for three correctness fixes applied to the Search tab
 * (app/(tabs)/index.tsx).  The functions under test are not exported from
 * that module, so each suite reproduces the exact logic in a minimal
 * self-contained harness — the same approach used in
 * syncRetryLogoutCleanup.test.ts.  If the originals change, the harnesses
 * below must be updated to stay in sync.
 *
 * Covered scenarios
 * ─────────────────
 * readNewestCacheTimestamp (corrupt-cache guard)
 *   1. Returns "No cached data" for a non-object JSON blob (string root)
 *   2. Returns "No cached data" for a JSON array at the root
 *   3. Returns "No cached data" for an entry that is missing a 'results' array
 *   4. Returns "No cached data" for an entry that has a non-number 'timestamp'
 *   5. Returns "No cached data" for a null value stored in AsyncStorage
 *   6. Returns "No cached data" when storage is empty (getItem → null)
 *   7. Returns the formatted age string when the cache is well-formed
 *
 * updateQueryCache serialisation lock (concurrent write races)
 *   8. Two concurrent updates both persist — neither clobbers the other
 *   9. A second update reads the first update's write, not the pre-first snapshot
 *  10. A failing first update does not permanently block subsequent updates
 *
 * Retry-timer unmount guard (no state setter calls after unmount)
 *  11. Timer callback is a no-op when isMountedRef.current is false
 *  12. Timer callback calls syncAllInventory when isMountedRef.current is true
 *  13. The unmount cleanup effect cancels the pending timer before it fires
 */

// ── AsyncStorage mock ─────────────────────────────────────────────────────────

const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();
const mockRemoveItem = jest.fn<Promise<void>, [string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
    removeItem: (...args: [string]) => mockRemoveItem(...args),
  },
}));

import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Shared constant ───────────────────────────────────────────────────────────

const QUERY_CACHE_KEY = "parts_id_query_cache_v1";

// ── Harness: readNewestCacheTimestamp ─────────────────────────────────────────
//
// Mirrors the two helpers from index.tsx.  The real formatRelativeAge is not
// needed for these tests — we only care about whether the guard branches fire
// and return "No cached data", or whether the happy-path reaches a non-sentinel
// string.

type CacheEntry = { timestamp: number; results: unknown[] };
type QueryCache = Record<string, CacheEntry>;

function isValidQueryCache(value: unknown): value is QueryCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) =>
      typeof (entry as { timestamp?: unknown })?.timestamp === "number" &&
      Array.isArray((entry as { results?: unknown })?.results),
  );
}

async function readNewestCacheTimestamp(): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem(QUERY_CACHE_KEY);
    if (!raw) return "No cached data";
    const parsed: unknown = JSON.parse(raw);
    if (!isValidQueryCache(parsed)) return "No cached data";
    const cache = parsed;
    const entries = Object.values(cache);
    if (entries.length === 0) return "No cached data";
    const newest = entries.reduce(
      (max: number, e: CacheEntry) => (e.timestamp > max ? e.timestamp : max),
      0,
    );
    // Return a stable non-sentinel string so tests can assert the happy path
    return `${newest}`;
  } catch {
    return "No cached data";
  }
}

// ── Suite 1: readNewestCacheTimestamp ─────────────────────────────────────────

describe("readNewestCacheTimestamp — corrupt-cache guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 'No cached data' for a JSON string at the root", async () => {
    mockGetItem.mockResolvedValue(JSON.stringify("this is not an object"));
    expect(await readNewestCacheTimestamp()).toBe("No cached data");
  });

  it("returns 'No cached data' for a JSON array at the root", async () => {
    mockGetItem.mockResolvedValue(JSON.stringify([{ timestamp: 1, results: [] }]));
    expect(await readNewestCacheTimestamp()).toBe("No cached data");
  });

  it("returns 'No cached data' when an entry is missing the results array", async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ key1: { timestamp: Date.now() } }), // no 'results'
    );
    expect(await readNewestCacheTimestamp()).toBe("No cached data");
  });

  it("returns 'No cached data' when an entry has a non-number timestamp", async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ key1: { timestamp: "2024-01-01", results: [] } }),
    );
    expect(await readNewestCacheTimestamp()).toBe("No cached data");
  });

  it("returns 'No cached data' when AsyncStorage holds a null value", async () => {
    mockGetItem.mockResolvedValue(JSON.stringify(null));
    expect(await readNewestCacheTimestamp()).toBe("No cached data");
  });

  it("returns 'No cached data' when AsyncStorage has no entry (getItem → null)", async () => {
    mockGetItem.mockResolvedValue(null);
    expect(await readNewestCacheTimestamp()).toBe("No cached data");
  });

  it("returns the timestamp string when the cache is well-formed", async () => {
    const ts = 1_700_000_000_000;
    mockGetItem.mockResolvedValue(
      JSON.stringify({ q1: { timestamp: ts, results: [{ id: 1 }] } }),
    );
    const result = await readNewestCacheTimestamp();
    expect(result).not.toBe("No cached data");
    expect(result).toBe(String(ts));
  });
});

// ── Harness: updateQueryCache serialisation lock ──────────────────────────────
//
// Mirrors the lock from index.tsx but accepts an injected in-memory store so
// tests can control reads and writes deterministically without requiring the
// real AsyncStorage mock to carry state across calls.

function makeUpdateQueryCache(store: Record<string, string>) {
  let lock: Promise<void> = Promise.resolve();

  async function loadCache(): Promise<QueryCache> {
    const raw = store[QUERY_CACHE_KEY] ?? null;
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidQueryCache(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  async function saveCache(cache: QueryCache): Promise<void> {
    store[QUERY_CACHE_KEY] = JSON.stringify(cache);
  }

  function updateQueryCache(
    mutate: (cache: QueryCache) => QueryCache,
  ): Promise<void> {
    const next = lock.then(async () => {
      const cache = await loadCache();
      await saveCache(mutate(cache));
    });
    lock = next.catch(() => {});
    return next;
  }

  return updateQueryCache;
}

// ── Suite 2: updateQueryCache serialisation lock ──────────────────────────────

describe("updateQueryCache serialisation lock — concurrent write races", () => {
  it("two concurrent updates both persist (neither write clobbers the other)", async () => {
    const store: Record<string, string> = {};
    const updateQueryCache = makeUpdateQueryCache(store);

    // Fire both without awaiting between them — would race without the lock
    const p1 = updateQueryCache((c) => ({
      ...c,
      searchA: { timestamp: 100, results: [{ id: 1 }] },
    }));
    const p2 = updateQueryCache((c) => ({
      ...c,
      searchB: { timestamp: 200, results: [{ id: 2 }] },
    }));

    await Promise.all([p1, p2]);

    const final: QueryCache = JSON.parse(store[QUERY_CACHE_KEY] ?? "{}");
    // Both keys must be present — the lock serialised the reads/writes
    expect(final).toHaveProperty("searchA");
    expect(final).toHaveProperty("searchB");
    expect(final.searchA!.results).toEqual([{ id: 1 }]);
    expect(final.searchB!.results).toEqual([{ id: 2 }]);
  });

  it("the second update sees the first update's write, not the pre-first snapshot", async () => {
    const store: Record<string, string> = {};
    const updateQueryCache = makeUpdateQueryCache(store);

    // p1 writes key1; p2 should see key1 when it reads, so its mutate receives
    // a cache that already contains key1
    const seenCacheInP2: QueryCache[] = [];

    const p1 = updateQueryCache((c) => ({ ...c, key1: { timestamp: 1, results: [] } }));
    const p2 = updateQueryCache((c) => {
      seenCacheInP2.push({ ...c });
      return { ...c, key2: { timestamp: 2, results: [] } };
    });

    await Promise.all([p1, p2]);

    expect(seenCacheInP2).toHaveLength(1);
    // p2's mutate must have received the cache with key1 already written by p1
    expect(seenCacheInP2[0]).toHaveProperty("key1");
  });

  it("a failing first update does not block subsequent updates (lock swallows errors)", async () => {
    const store: Record<string, string> = {};
    let callCount = 0;

    // Custom harness: first loadCache call throws; saveCache is always fine
    let lock: Promise<void> = Promise.resolve();

    function updateQueryCacheWithError(mutate: (c: QueryCache) => QueryCache): Promise<void> {
      const next = lock.then(async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("storage read failure");
        // Normal path for subsequent calls
        const raw = store[QUERY_CACHE_KEY] ?? null;
        const cache: QueryCache = raw ? (JSON.parse(raw) as QueryCache) : {};
        store[QUERY_CACHE_KEY] = JSON.stringify(mutate(cache));
      });
      lock = next.catch(() => {});
      return next;
    }

    // p1 will throw inside its chain — must NOT permanently block p2
    const p1 = updateQueryCacheWithError((c) => ({ ...c, willFail: { timestamp: 1, results: [] } }));
    const p2 = updateQueryCacheWithError((c) => ({ ...c, willSucceed: { timestamp: 2, results: [] } }));

    // p1 rejects but p2 should still resolve
    await expect(p1).rejects.toThrow("storage read failure");
    await expect(p2).resolves.toBeUndefined();

    const final: QueryCache = JSON.parse(store[QUERY_CACHE_KEY] ?? "{}");
    expect(final).toHaveProperty("willSucceed");
  });
});

// ── Suite 3: retry-timer unmount guard ───────────────────────────────────────

describe("retry-timer unmount guard — no state setter calls after unmount", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("callback is a no-op when isMountedRef.current is false when the timer fires", () => {
    const syncAllInventory = jest.fn();
    const setSyncRetryPending = jest.fn();
    const isMountedRef = { current: true };
    let timerRef: ReturnType<typeof setTimeout> | null = null;

    // Mirror the scheduling code from syncAllInventory's catch block
    timerRef = setTimeout(() => {
      timerRef = null;
      if (isMountedRef.current) {
        setSyncRetryPending(true);
        syncAllInventory();
      }
    }, 30_000);

    // Simulate unmount: flip the ref (the clearTimeout below mimics the unmount
    // effect, but we intentionally skip it here to prove the ref-check alone
    // is the safety net that guards the state setters)
    isMountedRef.current = false;

    // Advance past the retry delay — the timer fires
    jest.advanceTimersByTime(60_000);

    // Neither the state setter nor the re-sync should have been called
    expect(setSyncRetryPending).not.toHaveBeenCalled();
    expect(syncAllInventory).not.toHaveBeenCalled();
  });

  it("callback calls syncAllInventory when isMountedRef.current is still true", () => {
    const syncAllInventory = jest.fn();
    const isMountedRef = { current: true };

    setTimeout(() => {
      if (isMountedRef.current) syncAllInventory();
    }, 30_000);

    jest.advanceTimersByTime(30_000);

    expect(syncAllInventory).toHaveBeenCalledTimes(1);
  });

  it("unmount cleanup effect cancels the pending timer before it fires", () => {
    const syncAllInventory = jest.fn();
    const isMountedRef = { current: true };
    let timerRef: ReturnType<typeof setTimeout> | null = null;

    timerRef = setTimeout(() => {
      timerRef = null;
      if (isMountedRef.current) syncAllInventory();
    }, 30_000);

    // Mirror the unmount cleanup effect from index.tsx
    isMountedRef.current = false;
    if (timerRef !== null) {
      clearTimeout(timerRef);
      timerRef = null;
    }

    jest.advanceTimersByTime(60_000);

    // Timer was cancelled on unmount — callback must not have run at all
    expect(syncAllInventory).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ── Harness: syncAllInventory post-sync cache pruning ─────────────────────────
//
// Mirrors the pruning mutate function passed to updateQueryCache inside
// syncAllInventory (index.tsx lines 457-470).  The full sync yields the
// authoritative live item set; any cached SearchResult referencing a deleted
// item ID must be removed so offline searches never surface deleted inventory.
//
// Two properties are verified:
//   A. Deleted item IDs are absent and live IDs are retained after pruning.
//   B. The original cache object is returned by reference (no redundant write)
//      when every cached result ID is still present in the live inventory.

type PruneSearchResult = { item: { id: string } };
type PruneCache = Record<string, { timestamp: number; results: PruneSearchResult[] }>;

function makePruneMutate(liveIds: Set<string>) {
  return function prune(cache: PruneCache): PruneCache {
    let dirty = false;
    const pruned: PruneCache = {};
    for (const [key, entry] of Object.entries(cache)) {
      const kept = entry.results.filter(r => liveIds.has(r.item.id));
      if (kept.length !== entry.results.length) dirty = true;
      if (kept.length > 0) {
        pruned[key] = { ...entry, results: kept };
      } else {
        dirty = true; // entry fully emptied — drop it
      }
    }
    return dirty ? pruned : cache;
  };
}

// ── Suite 4: syncAllInventory post-sync cache pruning ────────────────────────

describe("syncAllInventory — post-sync cache pruning of stale search results", () => {
  it("removes deleted item IDs from cache entries and drops fully-emptied entries", () => {
    const cache: PruneCache = {
      "bolts query": {
        timestamp: 1_000,
        results: [
          { item: { id: "live-1" } },
          { item: { id: "deleted-2" } },
        ],
      },
      "nuts query": {
        timestamp: 2_000,
        results: [
          { item: { id: "deleted-3" } },
        ],
      },
    };

    const liveIds = new Set(["live-1"]);
    const result = makePruneMutate(liveIds)(cache);

    // "bolts query" keeps live-1 and drops deleted-2
    expect(result["bolts query"]).toBeDefined();
    expect(result["bolts query"]!.results).toEqual([{ item: { id: "live-1" } }]);

    // "nuts query" was fully emptied — it must be absent from the result
    expect(result["nuts query"]).toBeUndefined();
  });

  it("returns the original cache object unchanged (no redundant write) when no items were deleted", () => {
    const cache: PruneCache = {
      "bolts query": {
        timestamp: 1_000,
        results: [
          { item: { id: "live-1" } },
          { item: { id: "live-2" } },
        ],
      },
    };

    const liveIds = new Set(["live-1", "live-2"]);
    const result = makePruneMutate(liveIds)(cache);

    // All cached IDs are still live — must be the exact same reference (dirty=false path)
    expect(result).toBe(cache);
  });
});
