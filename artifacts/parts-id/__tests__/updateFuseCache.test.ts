/**
 * @jest-environment node
 *
 * Unit tests for the updateFuseCache helper
 * (artifacts/parts-id/lib/updateFuseCache.ts).
 *
 * Covers:
 *  1. Patching the correct item and writing the result back to AsyncStorage.
 *  2. Fast path: when knownItems is supplied, getItem is never called.
 *  3. Early-exit: when getItem returns null (no cache yet), setItem is skipped.
 *  4. Resilience: AsyncStorage errors are swallowed (cache failures are non-fatal).
 *  5. ID-miss: when updated.id is not in the cache the item is appended so
 *     edits to recently-added parts are not silently lost.
 */

import type { InventoryItem } from '@workspace/api-client-react';

// ── AsyncStorage mock ──────────────────────────────────────────────────────
const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
  },
}));

// ── Imports after mocks ────────────────────────────────────────────────────
import { updateFuseCache, FUSE_CACHE_KEY } from '../lib/updateFuseCache';

// ── Fixture ────────────────────────────────────────────────────────────────
function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 1,
    vendor: 'SQD',
    catalog: 'QO120',
    description: 'Original description',
    binLocations: ['A-1'],
    aiKeywords: ['breaker'],
    vendorFullName: 'Schneider Electric',
    enrichedAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    seriesName: null,
    seriesId: null,
    tradeSize: null,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('updateFuseCache', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AsyncStorage path (no knownItems)', () => {
    it('reads the cache, patches the matching item, and writes the result back', async () => {
      const cachedItems: InventoryItem[] = [
        makeItem({ id: 1, description: 'Old description', aiKeywords: ['old'] }),
        makeItem({ id: 2, description: 'Unrelated item' }),
      ];
      mockGetItem.mockResolvedValue(JSON.stringify(cachedItems));
      mockSetItem.mockResolvedValue(undefined);

      const updated = makeItem({ id: 1, description: 'New description', aiKeywords: ['new'] });
      await updateFuseCache(updated);

      // Should have read from the correct cache key.
      expect(mockGetItem).toHaveBeenCalledTimes(1);
      expect(mockGetItem).toHaveBeenCalledWith(FUSE_CACHE_KEY);

      // Should have written back with the patched item.
      expect(mockSetItem).toHaveBeenCalledTimes(1);
      const [writtenKey, writtenJson] = mockSetItem.mock.calls[0]!;
      expect(writtenKey).toBe(FUSE_CACHE_KEY);

      const writtenItems = JSON.parse(writtenJson) as InventoryItem[];
      expect(writtenItems).toHaveLength(2);

      // Item 1 should be patched.
      expect(writtenItems[0]!.id).toBe(1);
      expect(writtenItems[0]!.description).toBe('New description');
      expect(writtenItems[0]!.aiKeywords).toEqual(['new']);

      // Item 2 should be unchanged.
      expect(writtenItems[1]!.id).toBe(2);
      expect(writtenItems[1]!.description).toBe('Unrelated item');
    });

    it('appends the item when its id is not found in the cache', async () => {
      const cachedItems: InventoryItem[] = [
        makeItem({ id: 1, description: 'Existing item A' }),
        makeItem({ id: 2, description: 'Existing item B' }),
      ];
      mockGetItem.mockResolvedValue(JSON.stringify(cachedItems));
      mockSetItem.mockResolvedValue(undefined);

      const newItem = makeItem({ id: 99, description: 'Newly added part' });
      await updateFuseCache(newItem);

      expect(mockSetItem).toHaveBeenCalledTimes(1);
      const [writtenKey, writtenJson] = mockSetItem.mock.calls[0]!;
      expect(writtenKey).toBe(FUSE_CACHE_KEY);

      const writtenItems = JSON.parse(writtenJson) as InventoryItem[];
      // Original items must be unchanged.
      expect(writtenItems).toHaveLength(3);
      expect(writtenItems[0]!.id).toBe(1);
      expect(writtenItems[1]!.id).toBe(2);
      // New item must be appended so the edit is not silently lost.
      expect(writtenItems[2]!.id).toBe(99);
      expect(writtenItems[2]!.description).toBe('Newly added part');
    });

    it('does nothing when AsyncStorage returns null (cache is empty)', async () => {
      mockGetItem.mockResolvedValue(null);

      await updateFuseCache(makeItem({ id: 1 }));

      expect(mockGetItem).toHaveBeenCalledTimes(1);
      expect(mockSetItem).not.toHaveBeenCalled();
    });

    it('silently swallows AsyncStorage read errors without throwing', async () => {
      mockGetItem.mockRejectedValue(new Error('Disk error'));

      await expect(updateFuseCache(makeItem({ id: 1 }))).resolves.toBeUndefined();
      expect(mockSetItem).not.toHaveBeenCalled();
    });

    it('silently swallows AsyncStorage write errors without throwing', async () => {
      const cachedItems = [makeItem({ id: 1 })];
      mockGetItem.mockResolvedValue(JSON.stringify(cachedItems));
      mockSetItem.mockRejectedValue(new Error('Write error'));

      await expect(
        updateFuseCache(makeItem({ id: 1, description: 'Changed' }))
      ).resolves.toBeUndefined();
    });
  });

  describe('knownItems fast path (Search tab)', () => {
    it('skips getItem entirely when knownItems is provided', async () => {
      mockSetItem.mockResolvedValue(undefined);

      const knownItems: InventoryItem[] = [
        makeItem({ id: 1, description: 'Old description' }),
        makeItem({ id: 2, description: 'Another item' }),
      ];
      const updated = makeItem({ id: 1, description: 'Updated description' });

      await updateFuseCache(updated, knownItems);

      // AsyncStorage read must NOT be called when knownItems is supplied.
      expect(mockGetItem).not.toHaveBeenCalled();

      // Should still write the patched array back.
      expect(mockSetItem).toHaveBeenCalledTimes(1);
      const [writtenKey, writtenJson] = mockSetItem.mock.calls[0]!;
      expect(writtenKey).toBe(FUSE_CACHE_KEY);

      const writtenItems = JSON.parse(writtenJson) as InventoryItem[];
      expect(writtenItems[0]!.description).toBe('Updated description');
      expect(writtenItems[1]!.description).toBe('Another item');
    });

    it('appends the item when its id is not found in knownItems', async () => {
      mockSetItem.mockResolvedValue(undefined);

      const knownItems: InventoryItem[] = [
        makeItem({ id: 1, description: 'Existing item A' }),
        makeItem({ id: 2, description: 'Existing item B' }),
      ];
      const newItem = makeItem({ id: 99, description: 'Newly added part' });

      await updateFuseCache(newItem, knownItems);

      expect(mockGetItem).not.toHaveBeenCalled();
      expect(mockSetItem).toHaveBeenCalledTimes(1);
      const [, writtenJson] = mockSetItem.mock.calls[0]!;
      const writtenItems = JSON.parse(writtenJson) as InventoryItem[];
      expect(writtenItems).toHaveLength(3);
      expect(writtenItems[2]!.id).toBe(99);
      expect(writtenItems[2]!.description).toBe('Newly added part');
    });

    it('does not mutate the original knownItems array', async () => {
      mockSetItem.mockResolvedValue(undefined);

      const knownItems: InventoryItem[] = [makeItem({ id: 1, description: 'Original' })];
      const updated = makeItem({ id: 1, description: 'Changed' });

      await updateFuseCache(updated, knownItems);

      // The original array passed as knownItems must be unchanged.
      expect(knownItems[0]!.description).toBe('Original');
    });
  });
});
