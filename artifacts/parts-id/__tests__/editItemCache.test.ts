/**
 * Unit tests for editItemCache.ts — post-save React Query + AsyncStorage
 * cache invalidation helpers.
 *
 * All external dependencies are provided as in-memory mocks:
 *   • QueryClientLike / QueryClientLikeWithSetQueries — plain objects with
 *     jest.fn() implementations; no TanStack Query import required.
 *   • AsyncStorageLike — an in-memory key-value store.
 */

import {
  evictDeletedItemFromAllCaches,
  invalidateAllCachesAfterSave,
  invalidateListCache,
  invalidateSearchAndEvictItem,
} from "../utils/editItemCache";
import type {
  AsyncStorageLike,
  QueryClientLike,
  QueryClientLikeWithSetQueries,
} from "../utils/editItemCache";

import { getListInventoryQueryKey } from "@workspace/api-client-react";

import { QUERY_CACHE_KEY } from "../utils/searchHelpers";
import type { QueryCache } from "../utils/searchHelpers";

// Derive the expected list-key prefix from the real library so the predicate
// tests stay in sync if the generated key shape ever changes.
const LIST_KEY_PREFIX = getListInventoryQueryKey()[0];

// ── In-memory helpers ─────────────────────────────────────────────────────────

function makeQueryClient(): jest.Mocked<QueryClientLike> {
  return { invalidateQueries: jest.fn().mockResolvedValue(undefined) };
}

function makeQueryClientFull(): jest.Mocked<QueryClientLikeWithSetQueries> {
  return {
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
    setQueriesData: jest.fn(),
  };
}

function makeStorage(initial: Record<string, string> = {}): jest.Mocked<AsyncStorageLike> {
  const store: Record<string, string | null> = { ...initial };
  return {
    getItem: jest.fn(async (key: string) => store[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { store[key] = value; }),
  };
}

function serializeCache<R>(cache: QueryCache<R>): string {
  return JSON.stringify(cache);
}

type MinSearchResult = { item: { id: number } };

// =============================================================================
// invalidateListCache
// =============================================================================

describe("invalidateListCache", () => {
  it("calls invalidateQueries with a predicate that matches the list key prefix", async () => {
    const qc = makeQueryClient();
    await invalidateListCache({ queryClient: qc });
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
    const arg = qc.invalidateQueries.mock.calls[0][0] as { predicate: (q: { queryKey: unknown }) => boolean };
    expect(typeof arg.predicate).toBe("function");
  });

  it("predicate matches a query whose key starts with the list prefix", async () => {
    const qc = makeQueryClient();
    await invalidateListCache({ queryClient: qc });
    const { predicate } = qc.invalidateQueries.mock.calls[0][0] as {
      predicate: (q: { queryKey: unknown }) => boolean;
    };
    expect(predicate({ queryKey: [LIST_KEY_PREFIX] })).toBe(true);
    expect(predicate({ queryKey: [LIST_KEY_PREFIX, { page: 1 }] })).toBe(true);
  });

  it("predicate does not match searchInventory or other keys", async () => {
    const qc = makeQueryClient();
    await invalidateListCache({ queryClient: qc });
    const { predicate } = qc.invalidateQueries.mock.calls[0][0] as {
      predicate: (q: { queryKey: unknown }) => boolean;
    };
    expect(predicate({ queryKey: ["searchInventory"] })).toBe(false);
    expect(predicate({ queryKey: "not-an-array" })).toBe(false);
  });
});

// =============================================================================
// invalidateSearchAndEvictItem
// =============================================================================

describe("invalidateSearchAndEvictItem", () => {
  it("invalidates the searchInventory query key", async () => {
    const qc = makeQueryClient();
    const storage = makeStorage();
    await invalidateSearchAndEvictItem({ queryClient: qc, asyncStorage: storage, itemId: 1 });
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["searchInventory"] });
  });

  it("evicts the target item from the AsyncStorage cache and writes the pruned result", async () => {
    const qc = makeQueryClient();
    const cache: QueryCache<MinSearchResult> = {
      "q1": { timestamp: Date.now(), results: [{ item: { id: 1 } }, { item: { id: 2 } }] },
    };
    const storage = makeStorage({ [QUERY_CACHE_KEY]: serializeCache(cache) });

    await invalidateSearchAndEvictItem({ queryClient: qc, asyncStorage: storage, itemId: 1 });

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const written = JSON.parse((storage.setItem.mock.calls[0] as [string, string])[1]) as QueryCache<MinSearchResult>;
    expect(written["q1"].results).toHaveLength(1);
    expect(written["q1"].results[0].item.id).toBe(2);
  });

  it("does not write to AsyncStorage when the target item is not in the cache", async () => {
    const qc = makeQueryClient();
    const cache: QueryCache<MinSearchResult> = {
      "q1": { timestamp: Date.now(), results: [{ item: { id: 5 } }] },
    };
    const storage = makeStorage({ [QUERY_CACHE_KEY]: serializeCache(cache) });

    await invalidateSearchAndEvictItem({ queryClient: qc, asyncStorage: storage, itemId: 99 });

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not write when AsyncStorage is empty", async () => {
    const qc = makeQueryClient();
    const storage = makeStorage();

    await invalidateSearchAndEvictItem({ queryClient: qc, asyncStorage: storage, itemId: 1 });

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("swallows AsyncStorage parse failures (non-fatal)", async () => {
    const qc = makeQueryClient();
    const storage = makeStorage({ [QUERY_CACHE_KEY]: "NOT_VALID_JSON{{{{" });

    await expect(
      invalidateSearchAndEvictItem({ queryClient: qc, asyncStorage: storage, itemId: 1 }),
    ).resolves.toBeUndefined();

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("swallows AsyncStorage.getItem rejections (non-fatal)", async () => {
    const qc = makeQueryClient();
    const storage = makeStorage();
    (storage.getItem as jest.Mock).mockRejectedValue(new Error("disk full"));

    await expect(
      invalidateSearchAndEvictItem({ queryClient: qc, asyncStorage: storage, itemId: 1 }),
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// invalidateAllCachesAfterSave
// =============================================================================

describe("invalidateAllCachesAfterSave", () => {
  it("calls invalidateQueries twice — once for list, once for search", async () => {
    const qc = makeQueryClient();
    const storage = makeStorage();

    await invalidateAllCachesAfterSave({ queryClient: qc, asyncStorage: storage, itemId: 1 });

    expect(qc.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("includes both list-predicate and searchInventory key calls", async () => {
    const qc = makeQueryClient();
    const storage = makeStorage();

    await invalidateAllCachesAfterSave({ queryClient: qc, asyncStorage: storage, itemId: 1 });

    const calls = qc.invalidateQueries.mock.calls as Array<[unknown]>;
    const hasSearch = calls.some(
      ([arg]) => typeof arg === "object" && arg !== null && "queryKey" in arg,
    );
    const hasPredicate = calls.some(
      ([arg]) => typeof arg === "object" && arg !== null && "predicate" in arg,
    );
    expect(hasSearch).toBe(true);
    expect(hasPredicate).toBe(true);
  });
});

// =============================================================================
// evictDeletedItemFromAllCaches
// =============================================================================

describe("evictDeletedItemFromAllCaches", () => {
  it("calls setQueriesData twice — once for list, once for search caches", async () => {
    const qc = makeQueryClientFull();
    const storage = makeStorage();

    await evictDeletedItemFromAllCaches({ queryClient: qc, asyncStorage: storage, itemId: 7 });

    expect(qc.setQueriesData).toHaveBeenCalledTimes(2);
  });

  it("setQueriesData updater removes the target item from list results", () => {
    const qc = makeQueryClientFull();
    const storage = makeStorage();

    void evictDeletedItemFromAllCaches({ queryClient: qc, asyncStorage: storage, itemId: 7 });

    const [, listUpdater] = qc.setQueriesData.mock.calls[0] as [
      unknown,
      (old: { items: Array<{ id: number }> } | undefined) => { items: Array<{ id: number }> } | undefined,
    ];
    const result = listUpdater({ items: [{ id: 7 }, { id: 8 }] });
    expect(result?.items).toEqual([{ id: 8 }]);
  });

  it("setQueriesData updater returns undefined when given undefined", () => {
    const qc = makeQueryClientFull();
    const storage = makeStorage();

    void evictDeletedItemFromAllCaches({ queryClient: qc, asyncStorage: storage, itemId: 7 });

    const [, updater] = qc.setQueriesData.mock.calls[0] as [unknown, (old: undefined) => undefined];
    expect(updater(undefined)).toBeUndefined();
  });

  it("evicts item from the AsyncStorage offline search cache", async () => {
    const qc = makeQueryClientFull();
    const cache: QueryCache<MinSearchResult> = {
      "q1": { timestamp: Date.now(), results: [{ item: { id: 7 } }, { item: { id: 8 } }] },
    };
    const storage = makeStorage({ [QUERY_CACHE_KEY]: serializeCache(cache) });

    await evictDeletedItemFromAllCaches({ queryClient: qc, asyncStorage: storage, itemId: 7 });

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const written = JSON.parse((storage.setItem.mock.calls[0] as [string, string])[1]) as QueryCache<MinSearchResult>;
    expect(written["q1"].results).toHaveLength(1);
    expect(written["q1"].results[0].item.id).toBe(8);
  });

  it("swallows AsyncStorage parse failure without propagating", async () => {
    const qc = makeQueryClientFull();
    const storage = makeStorage({ [QUERY_CACHE_KEY]: "NOT_JSON{{{{" });

    await expect(
      evictDeletedItemFromAllCaches({ queryClient: qc, asyncStorage: storage, itemId: 7 }),
    ).resolves.toBeUndefined();
  });

  it("calls invalidateQueries twice after the synchronous evictions", async () => {
    const qc = makeQueryClientFull();
    const storage = makeStorage();

    await evictDeletedItemFromAllCaches({ queryClient: qc, asyncStorage: storage, itemId: 7 });

    expect(qc.invalidateQueries).toHaveBeenCalledTimes(2);
  });
});
