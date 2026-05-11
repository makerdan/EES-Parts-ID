/**
 * Tests for the in-progress upload persistence module.
 * AsyncStorage is mocked with an in-memory map.
 */

import {
  SEED_KEY,
  CHECKPOINT_KEY,
  CHUNK_SIZE,
  chunkRows,
  loadUploadProgress,
  saveUploadSeed,
  saveUploadCheckpoint,
  clearUploadProgress,
  type UploadSeed,
} from '../lib/uploadProgress';

let store: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => (key in store ? store[key] : null)),
  setItem: jest.fn(async (key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: jest.fn(async (key: string) => {
    delete store[key];
  }),
}));

beforeEach(() => {
  store = {};
});

const seed: UploadSeed = {
  fileName: 'inventory.csv',
  fileType: 'csv',
  parsedRows: [
    { vendor: 'EATON', catalog: 'BR120', description: '20A breaker', binLocations: ['A-1'] },
    { vendor: 'HUBBELL', catalog: 'HBL5262I', description: '20A receptacle' },
  ],
  mode: 'overwrite-all',
  startedAt: 1714600000000,
};

describe('uploadProgress persistence', () => {
  it('returns null when nothing is saved', async () => {
    expect(await loadUploadProgress()).toBeNull();
  });

  it('returns null when only the seed is saved (no checkpoint)', async () => {
    // Both keys must be present to resume a session: the seed describes what
    // rows to upload; the checkpoint says how far we got. Without both, the
    // upload cannot be safely continued, so we start fresh.
    store[SEED_KEY] = JSON.stringify(seed);
    expect(await loadUploadProgress()).toBeNull();
  });

  it('returns null when only the checkpoint is saved (no seed)', async () => {
    // Same invariant from the opposite direction: a checkpoint without the
    // original parsed rows is useless — we wouldn't know what to re-send.
    store[CHECKPOINT_KEY] = JSON.stringify({
      processedIndex: 0,
      totals: { inserted: 0, updated: 0, skipped: 0 },
    });
    expect(await loadUploadProgress()).toBeNull();
  });

  it('saveUploadSeed writes both keys with an initial 0 checkpoint', async () => {
    await saveUploadSeed(seed);
    const loaded = await loadUploadProgress();
    expect(loaded).not.toBeNull();
    expect(loaded?.parsedRows).toEqual(seed.parsedRows);
    expect(loaded?.processedIndex).toBe(0);
    expect(loaded?.totals).toEqual({ inserted: 0, updated: 0, skipped: 0 });
  });

  it('saveUploadCheckpoint updates only progress; rows are unchanged', async () => {
    await saveUploadSeed(seed);
    await saveUploadCheckpoint({
      processedIndex: 1,
      totals: { inserted: 0, updated: 1, skipped: 0 },
    });
    const loaded = await loadUploadProgress();
    expect(loaded?.processedIndex).toBe(1);
    expect(loaded?.totals).toEqual({ inserted: 0, updated: 1, skipped: 0 });
    expect(loaded?.parsedRows).toEqual(seed.parsedRows);
  });

  it('clearUploadProgress removes both keys', async () => {
    await saveUploadSeed(seed);
    await clearUploadProgress();
    expect(store[SEED_KEY]).toBeUndefined();
    expect(store[CHECKPOINT_KEY]).toBeUndefined();
    expect(await loadUploadProgress()).toBeNull();
  });

  it('returns null when seed JSON is corrupt', async () => {
    store[SEED_KEY] = '{not-json';
    store[CHECKPOINT_KEY] = JSON.stringify({
      processedIndex: 0,
      totals: { inserted: 0, updated: 0, skipped: 0 },
    });
    expect(await loadUploadProgress()).toBeNull();
  });

  it('returns null when checkpoint JSON is corrupt', async () => {
    store[SEED_KEY] = JSON.stringify(seed);
    store[CHECKPOINT_KEY] = '{not-json';
    expect(await loadUploadProgress()).toBeNull();
  });

  it('returns null when mode is not allowed', async () => {
    store[SEED_KEY] = JSON.stringify({ ...seed, mode: 'delete-all' });
    store[CHECKPOINT_KEY] = JSON.stringify({
      processedIndex: 0,
      totals: { inserted: 0, updated: 0, skipped: 0 },
    });
    expect(await loadUploadProgress()).toBeNull();
  });

  it('returns null when processedIndex is out of bounds', async () => {
    await saveUploadSeed(seed);
    await saveUploadCheckpoint({
      processedIndex: 99,
      totals: { inserted: 0, updated: 0, skipped: 0 },
    });
    expect(await loadUploadProgress()).toBeNull();
    await saveUploadCheckpoint({
      processedIndex: -1,
      totals: { inserted: 0, updated: 0, skipped: 0 },
    });
    expect(await loadUploadProgress()).toBeNull();
  });

  it('accepts add-multi-access mode (seed round-trips correctly)', async () => {
    const multiSeed: UploadSeed = { ...seed, mode: 'add-multi-access' };
    await saveUploadSeed(multiSeed);
    const loaded = await loadUploadProgress();
    expect(loaded).not.toBeNull();
    expect(loaded?.mode).toBe('add-multi-access');
    expect(loaded?.parsedRows).toEqual(seed.parsedRows);
  });

  it('preserves selectedKeys when present (selected mode)', async () => {
    const sel: UploadSeed = {
      ...seed,
      mode: 'selected',
      selectedKeys: [{ vendor: 'EATON', catalog: 'BR120' }],
    };
    await saveUploadSeed(sel);
    const loaded = await loadUploadProgress();
    expect(loaded?.mode).toBe('selected');
    expect(loaded?.selectedKeys).toEqual([{ vendor: 'EATON', catalog: 'BR120' }]);
  });
});

describe('chunkRows', () => {
  it('splits rows into fixed-size chunks with a possibly-short final chunk', () => {
    const rows = Array.from({ length: 53 }, (_, i) => i);
    const chunks = chunkRows(rows, 25);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(25);
    expect(chunks[1]).toHaveLength(25);
    expect(chunks[2]).toHaveLength(3);
    expect(chunks.flat()).toEqual(rows);
  });

  it('returns empty array for empty input', () => {
    expect(chunkRows([], 25)).toEqual([]);
  });

  it('returns a single chunk when rows.length < size', () => {
    expect(chunkRows([1, 2, 3], 25)).toEqual([[1, 2, 3]]);
  });

  it('uses CHUNK_SIZE by default', () => {
    const rows = Array.from({ length: CHUNK_SIZE + 1 }, (_, i) => i);
    const chunks = chunkRows(rows);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(CHUNK_SIZE);
    expect(chunks[1]).toHaveLength(1);
  });

  it('throws if size <= 0', () => {
    expect(() => chunkRows([1, 2], 0)).toThrow();
  });
});
