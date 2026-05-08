/**
 * Scheduled cleanup of stale enrichment runs.
 *
 * Deletes `inventory_enrichment_run` rows whose `startedAt` is older than
 * RETENTION_DAYS (7 days). Because `inventory_enrichment_history` has
 * `ON DELETE CASCADE` on its `runId` foreign key, all associated history
 * rows are removed automatically by Postgres.
 *
 * Follows the same start/stop/setInterval pattern as `inventoryIndex.ts`
 * so the server entry point can manage it identically.
 */
import { db, enrichmentRunTable } from '@workspace/db';
import { lt } from 'drizzle-orm';
import { logger } from './logger';

const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let timer: NodeJS.Timeout | null = null;
let stopped = false;

async function cleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  try {
    const deleted = await db
      .delete(enrichmentRunTable)
      .where(lt(enrichmentRunTable.startedAt, cutoff))
      .returning({ id: enrichmentRunTable.id });
    if (deleted.length === 0) {
      logger.info('enrichmentRunCleanup: nothing to clean up');
    } else {
      logger.info(
        { deletedCount: deleted.length, cutoff },
        'enrichmentRunCleanup: deleted old enrichment runs'
      );
    }
  } catch (err) {
    logger.error({ err }, 'enrichmentRunCleanup: cleanup failed');
  }
}

/**
 * Run an immediate cleanup then schedule daily repeats.
 * Safe to call once at server startup; subsequent calls are no-ops.
 */
export function start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  if (stopped) {
    logger.debug('enrichmentRunCleanup.start skipped — shutdown already requested');
    return;
  }
  const safeInterval = Math.max(1_000, Math.floor(intervalMs));
  void cleanup();
  timer = setInterval(() => {
    void cleanup();
  }, safeInterval);
  timer.unref?.();
  logger.info({ intervalMs: safeInterval }, 'enrichmentRunCleanup scheduler started');
}

/**
 * Cancel the cleanup timer. Called from the graceful-shutdown path.
 */
export function stop(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('enrichmentRunCleanup scheduler stopped');
  }
}
