import app from "./app";
import { logger } from "./lib/logger";
import { startServer, MAX_RETRIES } from "./lib/startServer";
import { db } from "@workspace/db";
import { catalogPdfJobTable, warehouseZoneTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { initProvider, probePoeBotsOnStartup } from "./lib/aiProvider";

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

const ZONE_SECTION_SENTINELS: { id: number; expectedSectionNum: number }[] = [
  { id: 431, expectedSectionNum: 3 },
  { id: 555, expectedSectionNum: 1 },
  { id: 840, expectedSectionNum: 1 },
];

async function checkZoneSectionNumIntegrity(): Promise<void> {
  try {
    const sentinelIds = ZONE_SECTION_SENTINELS.map((s) => s.id);
    const rows = await db
      .select({ id: warehouseZoneTable.id, sectionNum: warehouseZoneTable.sectionNum })
      .from(warehouseZoneTable)
      .where(inArray(warehouseZoneTable.id, sentinelIds));

    if (rows.length === 0) {
      logger.debug("Zone section_num integrity check skipped — no sentinel zones found (database may be empty)");
      return;
    }

    const mismatches: { id: number; expected: number; actual: number }[] = [];
    for (const sentinel of ZONE_SECTION_SENTINELS) {
      const row = rows.find((r) => r.id === sentinel.id);
      if (row && row.sectionNum !== sentinel.expectedSectionNum) {
        mismatches.push({ id: sentinel.id, expected: sentinel.expectedSectionNum, actual: row.sectionNum });
      }
    }

    if (mismatches.length > 0) {
      logger.warn(
        { mismatches },
        "⚠️  ZONE section_num DATA IS STALE — Map it! will show wrong section numbers for numeric aisles (13-22). " +
        "Run the fix script immediately:\n" +
        "  DATABASE_URL=\"$PROD_DATABASE_URL\" pnpm --filter @workspace/api-server exec tsx src/scripts/apply-zone-section-fix.ts\n" +
        "See docs/production-data-load.md for the full runbook.",
      );
    } else {
      logger.debug({ sentinelIds }, "Zone section_num integrity check passed");
    }
  } catch (err) {
    logger.error({ err }, "Failed to run zone section_num integrity check on startup");
  }
}

async function migrateAdminPreferences(): Promise<void> {
  try {
    await db.execute(sql`
      ALTER TABLE admin_preferences
        ADD COLUMN IF NOT EXISTS text_size TEXT NOT NULL DEFAULT 'normal',
        ADD COLUMN IF NOT EXISTS theme_mode TEXT NOT NULL DEFAULT 'system',
        ADD COLUMN IF NOT EXISTS default_confidence_threshold INTEGER NOT NULL DEFAULT 50,
        ADD COLUMN IF NOT EXISTS scan_sound BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS shelf_prefix TEXT,
        ADD COLUMN IF NOT EXISTS shelf_step INTEGER,
        ADD COLUMN IF NOT EXISTS ai_provider TEXT
    `);
  } catch (err) {
    logger.error({ err }, "Failed to migrate admin_preferences table");
  }
}

Promise.all([recoverOrphanedJobs(), initQuickLookupCache(), migrateAdminPreferences(), checkZoneSectionNumIntegrity()])
  .then(() => initProvider())
  .then(() => probePoeBotsOnStartup())
  .then(() => {
    startServer(app, port, MAX_RETRIES);
  });
