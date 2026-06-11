/**
 * @jest-environment node
 *
 * Guards the two post-save cache-invalidation contracts introduced in the
 * Edit Part screen (edit-item.tsx → handleSave → invalidateSearchAndEvictItem):
 *
 *   1. queryClient.invalidateQueries is called with { queryKey: ["searchInventory"] }
 *      after a successful save so the React Query cache is evicted and the next
 *      search fetches fresh data from the server.
 *
 *   2. AsyncStorage.setItem is called with the pruned query-cache payload when
 *      the edited item appears in the stored AsyncStorage search cache, so
 *      subsequent offline searches do not serve stale field values.
 *
 * The tests exercise the real `invalidateSearchAndEvictItem` utility from
 * utils/editItemCache.ts — the same function called by handleSave — with
 * mocked AsyncStorage and queryClient collaborators.
 *
 * Additional cases covered:
 *   3. setItem is NOT called when the edited item is absent from the cache
 *      (changed === false).
 *   4. setItem is NOT called when AsyncStorage holds no cache entry (getItem
 *      returns null).
 *   5. An AsyncStorage error in the eviction path is swallowed non-fatally.
 *   6. invalidateQueries is always called regardless of the AsyncStorage state.
 */

import { invalidateSearchAndEvictItem } from "../utils/editItemCache";
import { QUERY_CACHE_KEY } from "../utils/searchHelpers";
import type { QueryCache } from "../utils/searchHelpers";

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

type MockSearchResult = { item: { id: number; catalog: string } };

function makeCache(results: MockSearchResult[]): QueryCache<MockSearchResult> {
  return {
    '{"keywords":"breaker"}': { timestamp: Date.now(), results },
  };
}

// ── Per-test setup ────────────────────────────────────────────────────────────

let invalidateQueries: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  invalidateQueries = jest.fn().mockResolvedValue(undefined);
  mockSetItem.mockResolvedValue(undefined);
});

// =============================================================================
// invalidateSearchAndEvictItem — post-save cache invalidation contract
// =============================================================================

describe("invalidateSearchAndEvictItem — post-save cache invalidation contract", () => {
  it("calls invalidateQueries with { queryKey: ['searchInventory'] }", async () => {
    mockGetItem.mockResolvedValue(null);

    await invalidateSearchAndEvictItem({
      queryClient: { invalidateQueries },
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: 42,
    });

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["searchInventory"] });
  });

  it("calls AsyncStorage.setItem with the pruned cache when the saved item is present", async () => {
    const itemId = 7;
    const otherResult: MockSearchResult = { item: { id: 99, catalog: "RELAY-X" } };
    const editedResult: MockSearchResult = { item: { id: itemId, catalog: "BREAKER-A" } };
    const cache = makeCache([editedResult, otherResult]);

    mockGetItem.mockResolvedValue(JSON.stringify(cache));

    await invalidateSearchAndEvictItem({
      queryClient: { invalidateQueries },
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId,
    });

    expect(mockSetItem).toHaveBeenCalledTimes(1);

    const [calledKey, calledValue] = mockSetItem.mock.calls[0] as [string, string];
    expect(calledKey).toBe(QUERY_CACHE_KEY);

    const written = JSON.parse(calledValue) as QueryCache<MockSearchResult>;
    const entry = written['{"keywords":"breaker"}'];
    expect(entry).toBeDefined();
    // The edited item must have been evicted
    expect(entry!.results.some(r => r.item.id === itemId)).toBe(false);
    // The other item must be retained
    expect(entry!.results.some(r => r.item.id === 99)).toBe(true);
  });

  it("does NOT call AsyncStorage.setItem when the edited item is absent from the cache", async () => {
    const cache = makeCache([{ item: { id: 55, catalog: "SWITCH-B" } }]);
    mockGetItem.mockResolvedValue(JSON.stringify(cache));

    await invalidateSearchAndEvictItem({
      queryClient: { invalidateQueries },
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: 999, // not in cache
    });

    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it("does NOT call AsyncStorage.setItem when getItem returns null (no cached data)", async () => {
    mockGetItem.mockResolvedValue(null);

    await invalidateSearchAndEvictItem({
      queryClient: { invalidateQueries },
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: 42,
    });

    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it("swallows AsyncStorage errors non-fatally (does not throw)", async () => {
    mockGetItem.mockRejectedValue(new Error("AsyncStorage unavailable"));

    await expect(
      invalidateSearchAndEvictItem({
        queryClient: { invalidateQueries },
        asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
        itemId: 42,
      })
    ).resolves.toBeUndefined();
  });

  it("still calls invalidateQueries even when AsyncStorage throws", async () => {
    mockGetItem.mockRejectedValue(new Error("storage failure"));

    await invalidateSearchAndEvictItem({
      queryClient: { invalidateQueries },
      asyncStorage: { getItem: mockGetItem, setItem: mockSetItem },
      itemId: 42,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["searchInventory"] });
  });
});
