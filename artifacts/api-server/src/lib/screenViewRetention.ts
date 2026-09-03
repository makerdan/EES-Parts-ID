import { db, screenViewLogTable } from "@workspace/db";
import { lt } from "drizzle-orm";

import { logger } from "./logger";

export const SCREEN_VIEW_RETENTION_DAYS = 30;
export const SCREEN_VIEW_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function screenViewRetentionCutoff(now = Date.now()): Date {
  return new Date(now - SCREEN_VIEW_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Run independently of ingestion so an idle application still enforces TTL. */
export async function pruneScreenViewLog(now = Date.now()): Promise<void> {
  try {
    const deleted = await db
      .delete(screenViewLogTable)
      .where(lt(screenViewLogTable.createdAt, screenViewRetentionCutoff(now)))
      .returning({ id: screenViewLogTable.id });
    if (deleted.length > 0) {
      logger.info(
        { count: deleted.length, retentionDays: SCREEN_VIEW_RETENTION_DAYS },
        "Pruned old screen-view rows",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to prune screen-view rows");
  }
}