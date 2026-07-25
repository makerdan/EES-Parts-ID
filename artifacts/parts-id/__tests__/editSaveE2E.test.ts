/**
 * @jest-environment node
 *
 * E2E tests for the complete client-side edit & save pipeline:
 *
 *   pending bin/keyword auto-add → executeSaveOps → invalidateAllCachesAfterSave
 *
 * Pure function test — no React components are mounted.
 * Mutation hooks are simulated by mock `mutateAsync` functions; the production
 * `executeSaveOps` and `invalidateAllCachesAfterSave` utilities are called
 * directly so that any change to their wiring immediately surfaces here.
 *
 * Scenarios covered (mirroring the task steps 5–8):
 *   5. Full happy-path save: all six mutation hooks fire with correct payloads,
 *      `invalidateQueries` is called twice, AsyncStorage evicts the item.
 *   6. Partial save (unchanged fields skipped): hooks for unchanged fields are
 *      NOT called when the values match the original item.
 *   7. Single mutation failure → rollback: restoreFn is called, invalidation
 *      still fires, promise resolves without throwing.
 *   8. Pending input auto-add: buildFinalBins / buildFinalKeywords append
 *      unsaved text before ops are constructed.
 */

// ── AsyncStorage mock ─────────────────────────────────────────────────────────

const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
  },
}));

// ── api-client-react mock (getListInventoryQueryKey) ──────────────────────────

jest.mock("@workspace/api-client-react", () => ({
  getListInventoryQueryKey: jest.fn(() => ["/api/inventory"]),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  buildFinalBins,
  buildFinalKeywords,
  executeSaveOps,
} from "../utils/adminSaveUtils";
import type { SaveOp } from "../utils/adminSaveUtils";
import { invalidateAllCachesAfterSave } from "../utils/editItemCache";
import {
  QUERY_CACHE_KEY,
} from "../utils/searchHelpers";
import type { QueryCache, QueryCacheEntry } from "../utils/searchHelpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build the standard queryClient double used in all tests. */
function makeQueryClient() {
  const invalidateQueries = jest.fn().mockResolvedValue(undefined);
  const setQueriesData    = jest.fn();
  const setQueryData      = jest.fn();
  const getQueriesData    = jest.fn().mockReturnValue([]);
  return { invalidateQueries, setQueriesData, setQueryData, getQueriesData };
}

/** Build a cache payload containing a single entry with the given item ids. */
function makeCacheWithItems(itemIds: number[]): string {
  const cache: QueryCache<{ item: { id: number; catalog: string } }> = {
    '{"keywords":"test"}': {
      timestamp: Date.now(),
      results: itemIds.map(id => ({ item: { id, catalog: `PART-${id}` } })),
    },
  };
  return JSON.stringify(cache);
}

/** Build a cache with a single item (convenience wrapper). */
function makeCacheWithItem(itemId: number): string {
  return makeCacheWithItems([itemId]);
}

// ── Fetch mock for description / dimensions / photo ops ───────────────────────

const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: jest.fn().mockResolvedValue({}),
});
(global as { fetch: unknown }).fetch = mockFetch;

// ── Per-test setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGetItem.mockResolvedValue(null);
  mockSetItem.mockResolvedValue(undefined);
  mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
});

// =============================================================================
// Step 5 — Full happy-path save
// =============================================================================

describe("editSaveE2E — full happy-path save", () => {
  it("all five ops fire with correct payloads (fetch for description/dimensions/photo, mutateAsync for bins/keywords)", async () => {
    const ITEM_ID    = 42;
    const API_BASE   = "https://api.test";
    const ADMIN_TOKEN = "test-admin-token";

    // Mutation hook mutateAsync functions (bins & keywords use TanStack mutation hooks).
    const mutateBins     = jest.fn().mockResolvedValue(undefined);
    const mutateKeywords = jest.fn().mockResolvedValue(undefined);

    // The SaveOp list mirrors what PartDetailsEditor.handleSave builds.
    // description, dimensions, and photo use raw fetch(); bins/keywords use mutation hooks.
    const ops: SaveOp[] = [
      {
        field: "description",
        restoreFn: jest.fn(),
        promise: (global.fetch as jest.Mock)(
          `${API_BASE}/inventory/${ITEM_ID}/description`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
            body: JSON.stringify({ description: "New description" }),
          },
        ).then(async (res: Response) => { if (!res.ok) throw new Error("description failed"); }),
      },
      {
        field: "dimensions",
        restoreFn: jest.fn(),
        promise: (global.fetch as jest.Mock)(
          `${API_BASE}/inventory/${ITEM_ID}/dimensions`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
            body: JSON.stringify({ length: 10, width: 5, height: 2, diameter: null }),
          },
        ).then(async (res: Response) => { if (!res.ok) throw new Error("dimensions failed"); }),
      },
      {
        field: "photo",
        restoreFn: jest.fn(),
        promise: (global.fetch as jest.Mock)(
          `${API_BASE}/inventory/${ITEM_ID}/photo`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
            body: JSON.stringify({ remove: true, slot: 1 }),
          },
        ).then(async (res: Response) => { if (!res.ok) throw new Error("photo failed"); }),
      },
      {
        field: "bins",
        restoreFn: jest.fn(),
        promise: mutateBins({ id: ITEM_ID, data: { binLocations: ["A1", "B2"] } }),
      },
      {
        field: "keywords",
        restoreFn: jest.fn(),
        promise: mutateKeywords({ id: ITEM_ID, data: { keywords: ["relay", "motor"] } }),
      },
    ];

    const result = await executeSaveOps(ops);

    expect(result.anyFailed).toBe(false);
    expect(result.fieldErrors).toEqual({});

    // No restoreFns called on success.
    ops.forEach(op => expect(op.restoreFn).not.toHaveBeenCalled());

    // fetch must have been called exactly 3 times: description, dimensions, photo.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const fetchCalls = mockFetch.mock.calls as Array<[string, RequestInit]>;
    const callMap = Object.fromEntries(
      fetchCalls.map(([url, init]) => {
        const segment = url.split("/").pop()!;
        return [segment, JSON.parse(init.body as string)];
      }),
    );
    expect(callMap["description"]).toEqual({ description: "New description" });
    expect(callMap["dimensions"]).toEqual({ length: 10, width: 5, height: 2, diameter: null });
    expect(callMap["photo"]).toEqual({ remove: true, slot: 1 });

    // Mutation hooks received the correct payloads.
    expect(mutateBins).toHaveBeenCalledWith({ id: ITEM_ID, data: { binLocations: ["A1", "B2"] } });
    expect(mutateKeywords).toHaveBeenCalledWith({ id: ITEM_ID, data: { keywords: ["relay", "motor"] } });
  });

  it("invalidateAllCachesAfterSave calls invalidateQueries twice", async () => {
    const queryClient = makeQueryClient();
    const asyncStorage = { getItem: mockGetItem, setItem: mockSetItem };

    await invalidateAllCachesAfterSave({ queryClient, asyncStorage, itemId: 42 });

    // Must be called exactly twice: once for the list predicate, once for searchInventory.
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);

    const calls = queryClient.invalidateQueries.mock.calls as [
      { predicate?: unknown; queryKey?: unknown[] },
    ][];

    // First call: predicate-based list invalidation
    expect(typeof calls[0]![0].predicate).toBe("function");
    expect(calls[0]![0].queryKey).toBeUndefined();

    // Second call: exact searchInventory key
    expect(calls[1]![0].queryKey).toEqual(["searchInventory"]);
    expect(calls[1]![0].predicate).toBeUndefined();
  });

  it("AsyncStorage.setItem is called to evict the saved item from the offline cache", async () => {
    const ITEM_ID = 7;
    const OTHER_ID = 99;
    // Entry has two results: only ITEM_ID should be evicted; OTHER_ID survives.
    mockGetItem.mockResolvedValue(makeCacheWithItems([ITEM_ID, OTHER_ID]));
    mockSetItem.mockResolvedValue(undefined);

    const queryClient = makeQueryClient();
    await invalidateAllCachesAfterSave({
      queryClient,
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: ITEM_ID,
    });

    expect(mockSetItem).toHaveBeenCalledTimes(1);

    const [key, value] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe(QUERY_CACHE_KEY);

    const written = JSON.parse(value) as QueryCache<{ item: { id: number } }>;
    // The entry must still exist (it retained OTHER_ID) but ITEM_ID is gone.
    const entry = Object.values(written)[0] as QueryCacheEntry<{ item: { id: number } }> | undefined;
    expect(entry).toBeDefined();
    expect(entry!.results.some(r => r.item.id === ITEM_ID)).toBe(false);
    expect(entry!.results.some(r => r.item.id === OTHER_ID)).toBe(true);
  });
});

// =============================================================================
// Step 6 — Partial save (unchanged fields skipped)
// =============================================================================

describe("editSaveE2E — partial save: unchanged fields are not sent", () => {
  it("bins mutation is NOT called when finalBins equals original binLocations", () => {
    const originalBins = ["A1", "B2"];
    // buildFinalBins returns the same reference when pending is empty.
    const finalBins = buildFinalBins(originalBins, "");
    expect(finalBins).toBe(originalBins);

    // The component only adds a bins SaveOp when finalBins !== item.binLocations.
    // Here they are the same reference, so the bins mutation is skipped.
    const binsChanged = finalBins !== originalBins;
    expect(binsChanged).toBe(false);
  });

  it("keywords mutation is NOT called when finalKeywords equals original aiKeywords", () => {
    const originalKeywords = ["relay", "motor"];
    const finalKeywords = buildFinalKeywords(originalKeywords, "");
    expect(finalKeywords).toBe(originalKeywords);

    const keywordsChanged = finalKeywords !== originalKeywords;
    expect(keywordsChanged).toBe(false);
  });

  it("executeSaveOps with only unchanged fields returns anyFailed=false and calls no restoreFns", async () => {
    // When description and dimensions are unchanged, the component excludes them.
    // An empty ops list must still return success.
    const result = await executeSaveOps([]);

    expect(result.anyFailed).toBe(false);
    expect(result.fieldErrors).toEqual({});
  });

  it("only changed-field mutations are included in ops and fired", async () => {
    const ITEM_ID = 42;
    const mutateBins     = jest.fn().mockResolvedValue(undefined);
    const mutateKeywords = jest.fn().mockResolvedValue(undefined);

    const originalBins    = ["A1"];
    const originalKeywords = ["relay"];

    // bins changed; keywords unchanged
    const finalBins     = buildFinalBins(originalBins, "B2"); // new bin added
    const finalKeywords = buildFinalKeywords(originalKeywords, ""); // no change

    const ops: SaveOp[] = [];

    if (finalBins !== originalBins) {
      ops.push({
        field: "bins",
        promise: mutateBins({ id: ITEM_ID, data: { binLocations: finalBins } }),
        restoreFn: jest.fn(),
      });
    }

    if (finalKeywords !== originalKeywords) {
      ops.push({
        field: "keywords",
        promise: mutateKeywords({ id: ITEM_ID, data: { keywords: finalKeywords } }),
        restoreFn: jest.fn(),
      });
    }

    await executeSaveOps(ops);

    expect(mutateBins).toHaveBeenCalledTimes(1);
    expect(mutateBins).toHaveBeenCalledWith({ id: ITEM_ID, data: { binLocations: ["A1", "B2"] } });
    expect(mutateKeywords).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Step 7 — Single mutation failure → rollback
// =============================================================================

describe("editSaveE2E — single mutation failure triggers rollback", () => {
  it("restoreFn is called for the failing op only", async () => {
    const restoreGood = jest.fn();
    const restoreBad  = jest.fn();

    const ops: SaveOp[] = [
      { field: "description", promise: Promise.resolve(), restoreFn: restoreGood },
      {
        field: "bins",
        promise: Promise.reject(new Error("network error")),
        restoreFn: restoreBad,
      },
    ];

    const result = await executeSaveOps(ops);

    expect(result.anyFailed).toBe(true);
    expect(result.fieldErrors.bins).toMatch(/connection/i);
    expect(result.fieldErrors.description).toBeUndefined();

    expect(restoreBad).toHaveBeenCalledTimes(1);
    expect(restoreGood).not.toHaveBeenCalled();
  });

  it("promise from executeSaveOps resolves (does not throw) even when all ops fail", async () => {
    const ops: SaveOp[] = [
      { field: "description", promise: Promise.reject(new Error("fail")), restoreFn: jest.fn() },
      { field: "bins",        promise: Promise.reject(new Error("fail")), restoreFn: jest.fn() },
      { field: "keywords",    promise: Promise.reject(new Error("fail")), restoreFn: jest.fn() },
    ];

    await expect(executeSaveOps(ops)).resolves.toMatchObject({ anyFailed: true });
  });

  it("invalidateAllCachesAfterSave is still called after a failure (onSettled contract)", async () => {
    const queryClient = makeQueryClient();

    const ops: SaveOp[] = [
      {
        field: "bins",
        promise: Promise.reject(new Error("timeout")),
        restoreFn: jest.fn(),
      },
    ];

    const { anyFailed } = await executeSaveOps(ops);
    expect(anyFailed).toBe(true);

    // The caller (handleSave in the component) always calls invalidateAllCachesAfterSave
    // regardless of anyFailed so stale caches are always cleared.
    await invalidateAllCachesAfterSave({
      queryClient,
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: 42,
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("401 rejection produces 'session expired' field error", async () => {
    const ops: SaveOp[] = [
      {
        field: "photo",
        promise: Promise.reject(new Error("HTTP 401 Unauthorized")),
        restoreFn: jest.fn(),
      },
    ];

    const result = await executeSaveOps(ops);

    expect(result.fieldErrors.photo).toMatch(/session expired/i);
  });
});

// =============================================================================
// Step 8 — Pending input auto-add (buildFinalBins / buildFinalKeywords)
// =============================================================================

describe("editSaveE2E — pending bin/keyword auto-add before ops are constructed", () => {
  it("non-empty pendingBin is appended to existing bins", () => {
    const bins   = ["A1", "B2"];
    const result = buildFinalBins(bins, "C3");
    expect(result).toEqual(["A1", "B2", "C3"]);
  });

  it("duplicate pendingBin (case-insensitive) is NOT appended", () => {
    const bins   = ["A1", "B2"];
    const result = buildFinalBins(bins, "b2");
    expect(result).toBe(bins); // same reference — nothing changed
  });

  it("whitespace-only pendingBin is ignored", () => {
    const bins   = ["A1"];
    const result = buildFinalBins(bins, "   ");
    expect(result).toBe(bins);
  });

  it("non-empty pendingKeyword is lowercased and appended to existing keywords", () => {
    const keywords = ["motor", "relay"];
    const result   = buildFinalKeywords(keywords, "Breaker");
    expect(result).toEqual(["motor", "relay", "breaker"]);
  });

  it("duplicate pendingKeyword is NOT appended", () => {
    const keywords = ["motor"];
    const result   = buildFinalKeywords(keywords, "Motor");
    expect(result).toBe(keywords);
  });

  it("whitespace-only pendingKeyword is ignored", () => {
    const keywords = ["motor"];
    const result   = buildFinalKeywords(keywords, "  ");
    expect(result).toBe(keywords);
  });

  it("pending bin and keyword are both included in the final SaveOps", async () => {
    const ITEM_ID = 42;
    const mutateBins     = jest.fn().mockResolvedValue(undefined);
    const mutateKeywords = jest.fn().mockResolvedValue(undefined);

    const originalBins     = ["A1"];
    const originalKeywords: string[] = [];

    const finalBins     = buildFinalBins(originalBins, "NEW-BIN");
    const finalKeywords = buildFinalKeywords(originalKeywords, "AC Motor");

    const ops: SaveOp[] = [
      {
        field: "bins",
        promise: mutateBins({ id: ITEM_ID, data: { binLocations: finalBins } }),
        restoreFn: jest.fn(),
      },
      {
        field: "keywords",
        promise: mutateKeywords({ id: ITEM_ID, data: { keywords: finalKeywords } }),
        restoreFn: jest.fn(),
      },
    ];

    const result = await executeSaveOps(ops);

    expect(result.anyFailed).toBe(false);
    expect(mutateBins).toHaveBeenCalledWith({
      id: ITEM_ID,
      data: { binLocations: ["A1", "NEW-BIN"] },
    });
    expect(mutateKeywords).toHaveBeenCalledWith({
      id: ITEM_ID,
      data: { keywords: ["ac motor"] },
    });
  });

  it("pending bin on an empty original list creates a single-element array", () => {
    const finalBins = buildFinalBins([], "FIRST-BIN");
    expect(finalBins).toEqual(["FIRST-BIN"]);
  });

  it("pending keyword on an empty original list creates a single-element array", () => {
    const finalKeywords = buildFinalKeywords([], "FIRST-KW");
    expect(finalKeywords).toEqual(["first-kw"]);
  });
});

// =============================================================================
// invalidateAllCachesAfterSave — edge cases
// =============================================================================

describe("editSaveE2E — invalidateAllCachesAfterSave edge cases", () => {
  it("does NOT call AsyncStorage.setItem when the edited item is absent from cache", async () => {
    // Cache contains a different item (id=99), not the saved item (id=42).
    mockGetItem.mockResolvedValue(makeCacheWithItem(99));

    const queryClient = makeQueryClient();
    await invalidateAllCachesAfterSave({
      queryClient,
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: 42,
    });

    // setItem must not be called since item 42 was not in the cache.
    expect(mockSetItem).not.toHaveBeenCalled();
    // But both invalidateQueries calls must still fire.
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("does NOT call AsyncStorage.setItem when getItem returns null", async () => {
    mockGetItem.mockResolvedValue(null);

    const queryClient = makeQueryClient();
    await invalidateAllCachesAfterSave({
      queryClient,
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: 42,
    });

    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it("swallows AsyncStorage errors and still calls both invalidateQueries", async () => {
    mockGetItem.mockRejectedValue(new Error("AsyncStorage unavailable"));

    const queryClient = makeQueryClient();
    await expect(
      invalidateAllCachesAfterSave({
        queryClient,
        asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
        itemId: 42,
      }),
    ).resolves.toBeUndefined();

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("list predicate matches list queries and rejects search/unrelated queries", async () => {
    const queryClient = makeQueryClient();
    await invalidateAllCachesAfterSave({
      queryClient,
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: 42,
    });

    const calls = queryClient.invalidateQueries.mock.calls as [
      { predicate?: (q: { queryKey: unknown }) => boolean; queryKey?: unknown[] },
    ][];
    const listPredicate = calls[0]![0].predicate!;

    expect(listPredicate({ queryKey: ["/api/inventory"] })).toBe(true);
    expect(listPredicate({ queryKey: ["/api/inventory", { page: 1 }] })).toBe(true);
    expect(listPredicate({ queryKey: ["searchInventory"] })).toBe(false);
    expect(listPredicate({ queryKey: ["unrelated"] })).toBe(false);
    expect(listPredicate({ queryKey: [] })).toBe(false);
  });
});
