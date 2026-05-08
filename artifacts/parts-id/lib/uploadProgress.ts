/**
 * Persistence for an in-progress spreadsheet upload.
 *
 * The upload screen breaks a parsed sheet into fixed-size chunks and POSTs
 * them to /inventory/upsert-batch one chunk at a time. After each successful
 * chunk it calls saveUploadCheckpoint(...) here so that:
 *   - the user can pause the run and come back later, and
 *   - if the app is killed mid-run, the next launch can offer to resume.
 *
 * Storage is split into two keys to keep per-chunk writes cheap:
 *   - SEED_KEY      stores the large, static-for-the-run state: parsed rows,
 *                   file name/type, mode, selected keys, startedAt. Written
 *                   exactly once when the upload begins.
 *   - CHECKPOINT_KEY stores the tiny, per-chunk progress: processedIndex +
 *                   running totals. Written after every successful chunk.
 *
 * Resuming is safe because /inventory/upsert-batch is idempotent for the
 * relevant modes (additive bin merge, blank desc never overwrites, vendor +
 * catalog text on existing rows is never modified).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const SEED_KEY = '@partsid/upload_seed_v1';
export const CHECKPOINT_KEY = '@partsid/upload_checkpoint_v1';

/** Mirror of the mobile-side upsert mode union. */
export type UploadMode =
  | 'add-new-only'
  | 'overwrite-all'
  | 'selected'
  | 'bins-only'
  | 'add-multi-access';

/** Match the row shape consumed by /inventory/upsert-batch. */
export interface UploadRow {
  vendor: string;
  catalog: string;
  description: string;
  binLocations?: string[];
}

/** Static-for-the-run state. Written once when an upload starts. */
export interface UploadSeed {
  fileName: string | null;
  fileType: 'csv' | 'xlsx' | null;
  parsedRows: UploadRow[];
  mode: UploadMode;
  selectedKeys?: { vendor: string; catalog: string }[];
  startedAt: number;
}

/** Per-chunk progress. Written after every successful chunk. */
export interface UploadCheckpoint {
  processedIndex: number;
  totals: { inserted: number; updated: number; skipped: number };
}

/** Convenience union returned by loadUploadProgress(). */
export type InProgressUpload = UploadSeed & UploadCheckpoint;

function isValidSeed(v: unknown): v is UploadSeed {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<UploadSeed>;
  return (
    Array.isArray(o.parsedRows) &&
    typeof o.startedAt === 'number' &&
    (o.mode === 'add-new-only' ||
      o.mode === 'overwrite-all' ||
      o.mode === 'selected' ||
      o.mode === 'bins-only' ||
      o.mode === 'add-multi-access')
  );
}

function isValidCheckpoint(v: unknown): v is UploadCheckpoint {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<UploadCheckpoint>;
  return (
    typeof o.processedIndex === 'number' &&
    !!o.totals &&
    typeof o.totals.inserted === 'number' &&
    typeof o.totals.updated === 'number' &&
    typeof o.totals.skipped === 'number'
  );
}

/**
 * Read the saved in-progress upload, if any. Returns null on missing keys,
 * parse error, schema mismatch, or out-of-range processedIndex.
 */
export async function loadUploadProgress(): Promise<InProgressUpload | null> {
  let seedRaw: string | null;
  let cpRaw: string | null;
  try {
    [seedRaw, cpRaw] = await Promise.all([
      AsyncStorage.getItem(SEED_KEY),
      AsyncStorage.getItem(CHECKPOINT_KEY),
    ]);
  } catch {
    return null;
  }
  if (!seedRaw || !cpRaw) return null;
  let seed: unknown;
  let cp: unknown;
  try {
    seed = JSON.parse(seedRaw);
    cp = JSON.parse(cpRaw);
  } catch {
    return null;
  }
  if (!isValidSeed(seed) || !isValidCheckpoint(cp)) return null;
  if (cp.processedIndex < 0 || cp.processedIndex > seed.parsedRows.length) return null;
  return {
    fileName: seed.fileName ?? null,
    fileType: seed.fileType ?? null,
    parsedRows: seed.parsedRows,
    mode: seed.mode,
    selectedKeys: Array.isArray(seed.selectedKeys) ? seed.selectedKeys : undefined,
    startedAt: seed.startedAt,
    processedIndex: cp.processedIndex,
    totals: cp.totals,
  };
}

/**
 * Persist the static-for-the-run seed + an initial 0 checkpoint. Called
 * exactly once when an upload starts. Errors are swallowed — failing to
 * persist only weakens crash recovery; it never corrupts an upload.
 */
export async function saveUploadSeed(seed: UploadSeed): Promise<void> {
  try {
    await Promise.all([
      AsyncStorage.setItem(SEED_KEY, JSON.stringify(seed)),
      AsyncStorage.setItem(
        CHECKPOINT_KEY,
        JSON.stringify({ processedIndex: 0, totals: { inserted: 0, updated: 0, skipped: 0 } })
      ),
    ]);
  } catch {
    /* ignore */
  }
}

/**
 * Persist a small progress checkpoint. Called after every successful chunk
 * and whenever the user pauses. Significantly cheaper than rewriting the
 * full parsedRows blob each time.
 */
export async function saveUploadCheckpoint(checkpoint: UploadCheckpoint): Promise<void> {
  try {
    await AsyncStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch {
    /* ignore */
  }
}

/** Remove all saved progress (called on success or when the user discards). */
export async function clearUploadProgress(): Promise<void> {
  try {
    await Promise.all([AsyncStorage.removeItem(SEED_KEY), AsyncStorage.removeItem(CHECKPOINT_KEY)]);
  } catch {
    /* ignore */
  }
}

/** Default chunk size — kept here so tests and the screen stay in sync. */
export const CHUNK_SIZE = 25;

/**
 * Split rows into fixed-size chunks for sequential upload.
 * The final chunk may be shorter than CHUNK_SIZE.
 */
export function chunkRows<T>(rows: readonly T[], size: number = CHUNK_SIZE): T[][] {
  if (size <= 0) throw new Error('chunkRows: size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}
