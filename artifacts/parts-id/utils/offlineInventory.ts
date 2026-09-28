import type { InventoryItem } from "@workspace/api-client-react";
import * as SQLite from "expo-sqlite";
import Fuse from "fuse.js";

import { InventoryCacheLimitError, syncInventoryPages } from "@/utils/searchHelpers";

// Two generations keep the last committed snapshot readable during an interrupted
// download. The only visibility switch is the metadata update in finishSync.
export const OFFLINE_PAGE_SIZE = 200;
export const OFFLINE_PAGE_BYTES = 2 * 1024 * 1024;
export const OFFLINE_SNAPSHOT_BYTES = 80 * 1024 * 1024;
const DB_NAME = "parts-offline-v1.db";
type Meta = { generation: number; synced_at: number; count: number };
type Row = { json: string };
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function database(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS offline_meta (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, synced_at INTEGER NOT NULL, count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS offline_items (generation INTEGER NOT NULL, id INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (generation, id));
        CREATE VIRTUAL TABLE IF NOT EXISTS offline_terms USING fts5(generation UNINDEXED, id UNINDEXED, terms);
        CREATE TABLE IF NOT EXISTS offline_barcodes (generation INTEGER NOT NULL, code TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (generation, code, id));
        CREATE INDEX IF NOT EXISTS offline_barcodes_lookup ON offline_barcodes(generation, code);
      `);
      return db;
    })().catch(err => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

async function active(db: Pick<SQLite.SQLiteDatabase, "getFirstAsync">): Promise<Meta | null> {
  return db.getFirstAsync<Meta>("SELECT generation, synced_at, count FROM offline_meta WHERE id = 1");
}

function terms(item: InventoryItem): string {
  return [item.catalog, item.description, item.vendor, item.aiKeywords].filter(Boolean).join(" ");
}

async function writeItem(db: Pick<SQLite.SQLiteDatabase, "runAsync">, generation: number, item: InventoryItem) {
  await db.runAsync("DELETE FROM offline_terms WHERE generation = ? AND id = ?", generation, item.id);
  await db.runAsync("DELETE FROM offline_barcodes WHERE generation = ? AND id = ?", generation, item.id);
  await db.runAsync("INSERT OR REPLACE INTO offline_items VALUES (?, ?, ?)", generation, item.id, JSON.stringify(item));
  await db.runAsync("INSERT INTO offline_terms (generation, id, terms) VALUES (?, ?, ?)", generation, item.id, terms(item));
  for (const code of new Set(item.barcodes ?? [])) {
    await db.runAsync("INSERT INTO offline_barcodes VALUES (?, ?, ?)", generation, code, item.id);
  }
}

export async function offlineSnapshotInfo(): Promise<{ count: number; syncedAt: number } | null> {
  const db = await database();
  const meta = await active(db);
  return meta ? { count: meta.count, syncedAt: meta.synced_at } : null;
}

export async function syncOfflineInventory(
  fetchPage: (page: number, size: number) => Promise<{ items: Array<InventoryItem>; total: number }>,
  signal: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const db = await database();
  const generation = (await active(db))?.generation === 1 ? 2 : 1;
  // A previous interrupted stage is never visible. Reclaim it before downloading.
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync("DELETE FROM offline_items WHERE generation = ?", generation);
    await tx.runAsync("DELETE FROM offline_terms WHERE generation = ?", generation);
    await tx.runAsync("DELETE FROM offline_barcodes WHERE generation = ?", generation);
  });
  let bytes = 0;
  const loaded = await syncInventoryPages(fetchPage, async (items) => {
    if (signal.aborted) throw new Error("Sync aborted");
    const serialized = items.map(item => JSON.stringify(item));
    const pageBytes = serialized.reduce((sum, json) => sum + new TextEncoder().encode(json).length, 0);
    if (pageBytes > OFFLINE_PAGE_BYTES || bytes + pageBytes > OFFLINE_SNAPSHOT_BYTES) throw new InventoryCacheLimitError();
    await db.withExclusiveTransactionAsync(async tx => {
      if (signal.aborted) throw new Error("Sync aborted");
      for (const item of items) await writeItem(tx, generation, item);
    });
    bytes += pageBytes;
  }, OFFLINE_PAGE_SIZE, onProgress, signal);
  if (signal.aborted) throw new Error("Sync aborted");
  const staged = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM offline_items WHERE generation = ?", generation,
  );
  // Complete pages alone aren't enough if the server returned duplicate IDs.
  const count = staged?.count ?? 0;
  if (count !== loaded) throw new Error("Duplicate inventory IDs in offline sync");
  await db.withExclusiveTransactionAsync(async tx => {
    if (signal.aborted) throw new Error("Sync aborted");
    await tx.runAsync(
      "INSERT OR REPLACE INTO offline_meta (id, generation, synced_at, count) VALUES (1, ?, ?, ?)",
      generation, Date.now(), count,
    );
  });
  // Reclaim old snapshot after publication. Failure here doesn't roll back the new one.
  const previous = generation === 1 ? 2 : 1;
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync("DELETE FROM offline_items WHERE generation = ?", previous);
    await tx.runAsync("DELETE FROM offline_terms WHERE generation = ?", previous);
    await tx.runAsync("DELETE FROM offline_barcodes WHERE generation = ?", previous);
  }).catch(() => {});
}

export async function searchOfflineInventory(query: string): Promise<Array<InventoryItem>> {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(t => t.length >= 2).slice(0, 8) ?? [];
  if (!tokens.length) return [];
  const db = await database();
  let candidates: Array<Row> = [];
  await db.withExclusiveTransactionAsync(async tx => {
    const meta = await active(tx);
    if (!meta) return;
    // Read the pointer and candidates under one snapshot. Cleanup of the old
    // generation cannot interleave after we read the pointer.
    const queryRows = (match: string) => tx.getAllAsync<Row>(
      `SELECT i.json FROM offline_terms
       JOIN offline_items AS i ON i.generation = offline_terms.generation AND i.id = offline_terms.id
       WHERE offline_terms.generation = ? AND offline_terms MATCH ?
       ORDER BY rank LIMIT 200`,
      meta.generation, match,
    );
    const exact = tokens.length > 1 ? await queryRows(`"${tokens.join(" ")}"`) : [];
    candidates = exact.length ? exact : await queryRows(tokens.map(t => `"${t}"*`).join(" OR "));
  });
  const fuse = new Fuse(candidates.map(row => JSON.parse(row.json) as InventoryItem), {
    keys: [{ name: "catalog", weight: 0.35 }, { name: "description", weight: 0.30 },
      { name: "vendor", weight: 0.10 }, { name: "aiKeywords", weight: 0.25 }],
    threshold: 0.45, ignoreLocation: true, minMatchCharLength: 2,
  });
  const hits = fuse.search(query, { limit: 30 }).map(hit => hit.item);
  if (hits.length) return hits;
  // FTS cannot retrieve misspellings. Preserve the old Fuse fallback without
  // constructing an all-catalog index: scan one disk page at a time.
  let afterId = -1;
  const ranked: Array<{ item: InventoryItem; score: number }> = [];
  for (;;) {
    const rows = await db.getAllAsync<{ id: number; json: string }>(
      `SELECT i.id, i.json FROM offline_items i JOIN offline_meta m ON i.generation = m.generation
       WHERE m.id = 1 AND i.id > ? ORDER BY i.id LIMIT 200`, afterId,
    );
    if (!rows.length) break;
    const page = new Fuse(rows.map(row => JSON.parse(row.json) as InventoryItem), {
      keys: [{ name: "catalog", weight: 0.35 }, { name: "description", weight: 0.30 },
        { name: "vendor", weight: 0.10 }, { name: "aiKeywords", weight: 0.25 }],
      threshold: 0.45, ignoreLocation: true, minMatchCharLength: 2, includeScore: true,
    });
    ranked.push(...page.search(query, { limit: 30 }).map(hit => ({ item: hit.item, score: hit.score ?? 1 })));
    ranked.sort((a, b) => a.score - b.score);
    ranked.length = Math.min(ranked.length, 30);
    afterId = rows.at(-1)!.id;
  }
  return ranked.map(hit => hit.item);
}

export async function lookupOfflineBarcode(code: string): Promise<InventoryItem | null> {
  const db = await database();
  const row = await db.getFirstAsync<Row>(
    `SELECT i.json FROM offline_meta m JOIN offline_barcodes b ON b.generation = m.generation
     JOIN offline_items i ON i.generation = b.generation AND i.id = b.id
     WHERE m.id = 1 AND b.code = ? LIMIT 1`, code,
  );
  return row ? JSON.parse(row.json) as InventoryItem : null;
}

export async function upsertOfflineItem(item: InventoryItem): Promise<void> {
  const db = await database();
  await db.withExclusiveTransactionAsync(async tx => {
    const meta = await active(tx);
    if (!meta) return;
    const nextBytes = new TextEncoder().encode(JSON.stringify(item)).length;
    if (nextBytes > OFFLINE_PAGE_BYTES) throw new InventoryCacheLimitError();
    const size = await tx.getFirstAsync<{ used: number; previous: number }>(
      `SELECT COALESCE(SUM(LENGTH(CAST(json AS BLOB))), 0) AS used,
       COALESCE(SUM(CASE WHEN id = ? THEN LENGTH(CAST(json AS BLOB)) ELSE 0 END), 0) AS previous
       FROM offline_items WHERE generation = ?`, item.id, meta.generation,
    );
    if ((size?.used ?? 0) - (size?.previous ?? 0) + nextBytes > OFFLINE_SNAPSHOT_BYTES) {
      throw new InventoryCacheLimitError();
    }
    await writeItem(tx, meta.generation, item);
    await tx.runAsync("UPDATE offline_meta SET count = (SELECT COUNT(*) FROM offline_items WHERE generation = ?) WHERE id = 1", meta.generation);
  });
}

export async function deleteOfflineItem(id: number): Promise<void> {
  const db = await database();
  await db.withExclusiveTransactionAsync(async tx => {
    // Delete from both generations to avoid a concurrent sync resurrecting it.
    await tx.runAsync("DELETE FROM offline_items WHERE id = ?", id);
    await tx.runAsync("DELETE FROM offline_terms WHERE id = ?", id);
    await tx.runAsync("DELETE FROM offline_barcodes WHERE id = ?", id);
    await tx.runAsync("UPDATE offline_meta SET count = (SELECT COUNT(*) FROM offline_items AS i WHERE i.generation = offline_meta.generation) WHERE id = 1");
  });
}

export async function hasOfflineItem(id: number): Promise<boolean> {
  const db = await database();
  const row = await db.getFirstAsync<{ id: number }>(
    "SELECT i.id FROM offline_items i JOIN offline_meta m ON i.generation = m.generation WHERE m.id = 1 AND i.id = ?", id,
  );
  return !!row;
}