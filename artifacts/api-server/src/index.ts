import app from "./app";
import { logger } from "./lib/logger";
import { startServer, MAX_RETRIES } from "./lib/startServer";
import { db } from "@workspace/db";
import { catalogPdfJobTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function recoverOrphanedJobs(): Promise<void> {
  try {
    const result = await db
      .update(catalogPdfJobTable)
      .set({
        status: "failed",
        errorMessage: "Server restarted while job was in progress. Please resubmit the PDF.",
        finishedAt: new Date(),
      })
      .where(eq(catalogPdfJobTable.status, "processing"))
      .returning({ id: catalogPdfJobTable.id });

    if (result.length > 0) {
      logger.warn(
        { orphanedJobIds: result.map((r) => r.id) },
        `Marked ${result.length} orphaned PDF job(s) as failed on startup`,
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to recover orphaned PDF jobs on startup");
  }
}

async function initQuickLookupCache(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS quick_lookup_cache (
        label TEXT PRIMARY KEY,
        answer TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  } catch (err) {
    logger.error({ err }, "Failed to initialize quick_lookup_cache table");
  }
}

async function migrateAdminPreferences(): Promise<void> {
  try {
    await db.execute(sql`
      ALTER TABLE admin_preferences
        ADD COLUMN IF NOT EXISTS text_size TEXT NOT NULL DEFAULT 'normal',
        ADD COLUMN IF NOT EXISTS theme_mode TEXT NOT NULL DEFAULT 'system',
        ADD COLUMN IF NOT EXISTS default_confidence_threshold INTEGER NOT NULL DEFAULT 50,
        ADD COLUMN IF NOT EXISTS scan_sound BOOLEAN NOT NULL DEFAULT true
    `);
  } catch (err) {
    logger.error({ err }, "Failed to migrate admin_preferences table");
  }
}

Promise.all([recoverOrphanedJobs(), initQuickLookupCache(), migrateAdminPreferences()]).then(() => {
  startServer(app, port, MAX_RETRIES);
});
