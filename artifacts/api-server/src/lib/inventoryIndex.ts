/**
 * Long-lived in-memory Fuse.js fuzzy-search index over the inventory
 * table. Built once at server startup and refreshed on a schedule so
 * the search-route fallback path doesn't pay the cost of re-reading
 * `inventory` and re-tokenizing every request.
 *
 * The Fuse config here MUST stay in sync with the inline config that
 * `routes/inventory.ts` previously used so search behavior is
 * unchanged. Refreshes are guarded against overlap, and a refresh that
 * throws keeps the previous index in place so traffic is never served
 * by an empty index.
 */
import Fuse, { type IFuseOptions } from "fuse.js";
import { db, inventoryTable } from "@workspace/db";
import { logger } from "./logger";

type InventoryRow = typeof inventoryTable.$inferSelect;

const FUSE_OPTIONS: IFuseOptions<InventoryRow> = {
  keys: [
    { name: "catalog", weight: 0.35 },
    { name: "description", weight: 0.30 },
    { name: "vendor", weight: 0.10 },
    { name: "aiKeywords", weight: 0.25 },
  ],
  threshold: 0.45,
  ignoreLocation: true,
  minMatchCharLength: 2,
  findAllMatches: true,
  includeScore: true,
};

interface IndexState {
  fuse: Fuse<InventoryRow>;
  builtAt: Date;
  rowCount: number;
}

let current: IndexState | null = null;
let refreshing = false;
let timer: NodeJS.Timeout | null = null;
let lastError: unknown = null;
// Set by stop() so a pending start() called from a startup .finally()
// after shutdown began doesn't resurrect the refresh timer.
let stopped = false;

export const FUSE_OPTIONS_FOR_INVENTORY = FUSE_OPTIONS;

/**
 * Returns the current cached Fuse instance, or null if the very first
 * build hasn't completed yet (callers should fall back to skipping the
 * fuzzy step in that rare window rather than building inline).
 */
export function getIndex(): Fuse<InventoryRow> | null {
  return current?.fuse ?? null;
}

export function getIndexMeta(): { builtAt: Date; rowCount: number } | null {
  return current ? { builtAt: current.builtAt, rowCount: current.rowCount } : null;
}

export function getLastIndexError(): unknown {
  return lastError;
}

/**
 * Rebuild the Fuse index from a fresh `SELECT * FROM inventory`. Skips
 * if a previous refresh is still running. On success, atomically swaps
 * in the new instance; on failure, logs and keeps the previous one.
 */
export async function refresh(): Promise<void> {
  if (refreshing) {
    logger.debug("inventoryIndex.refresh skipped — previous refresh still running");
    return;
  }
  refreshing = true;
  const startedAt = Date.now();
  try {
    const rows = await db.select().from(inventoryTable);
    const fuse = new Fuse(rows, FUSE_OPTIONS);
    current = { fuse, builtAt: new Date(), rowCount: rows.length };
    lastError = null;
    logger.info(
      { rowCount: rows.length, durationMs: Date.now() - startedAt },
      "inventoryIndex refreshed",
    );
  } catch (err) {
    lastError = err;
    logger.error({ err }, "inventoryIndex refresh failed — keeping previous index");
  } finally {
    refreshing = false;
  }
}

/**
 * Begin the periodic-refresh timer. Safe to call once at startup. The
 * interval is capped at >= 1s so a misconfigured env var can't pin
 * the event loop. Subsequent calls are no-ops if a timer is already
 * running.
 */
export function start(intervalMs: number): void {
  if (timer) return;
  if (stopped) {
    logger.debug("inventoryIndex.start skipped — shutdown already requested");
    return;
  }
  const safeInterval = Math.max(1_000, Math.floor(intervalMs));
  timer = setInterval(() => {
    void refresh();
  }, safeInterval);
  // Don't keep the event loop alive just for this timer.
  timer.unref?.();
  logger.info({ intervalMs: safeInterval }, "inventoryIndex scheduler started");
}

/**
 * Stop the periodic-refresh timer. Called from the graceful-shutdown
 * path so the process can exit promptly.
 */
export function stop(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("inventoryIndex scheduler stopped");
  }
}
