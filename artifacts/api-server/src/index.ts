import { db } from "@workspace/db";
import { catalogPdfJobTable, warehouseZoneTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

import app from "./app";
import { initProvider, probePoeBotsOnStartup } from "./lib/aiProvider";
import { logger } from "./lib/logger";
import { MAX_RETRIES,startServer } from "./lib/startServer";
import { validateEnv } from "./lib/validateEnv";

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — exiting");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — exiting");
  process.exit(1);
});

const rawPort = process.env["PORT"];
const isDev = process.env["NODE_ENV"] !== "production";

if (!rawPort && isDev) {
  logger.warn("PORT env var not set — falling back to 3001 in development");
}

const port = rawPort ? Number(rawPort) : isDev ? 3001 : NaN;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(
    rawPort
      ? `Invalid PORT value: "${rawPort}"`
      : "PORT environment variable is required but was not provided.",
  );
}

validateEnv();

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

const ZONE_SECTION_SENTINELS: Array<{ id: number; expectedSectionNum: number }> = [
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

    const mismatches: Array<{ id: number; expected: number; actual: number | null }> = [];
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
        ADD COLUMN IF NOT EXISTS ai_provider TEXT,
        ADD COLUMN IF NOT EXISTS revoked_before BIGINT NOT NULL DEFAULT 0
    `);
  } catch (err) {
    logger.error({ err }, "Failed to migrate admin_preferences table");
  }
}


async function migrateWarehouseZoneNullSectionNum(): Promise<void> {
  try {
    // Make section_num nullable if it still has a NOT NULL constraint.
    await db.execute(sql`
      ALTER TABLE warehouse_zone ALTER COLUMN section_num DROP NOT NULL
    `);
  } catch (err) {
    logger.error({ err }, "migrateWarehouseZoneNullSectionNum: failed to DROP NOT NULL on section_num — skipping");
  }
  try {
    // Drop the column default so new inserts don't fall back to 0.
    await db.execute(sql`
      ALTER TABLE warehouse_zone ALTER COLUMN section_num DROP DEFAULT
    `);
  } catch (err) {
    logger.error({ err }, "migrateWarehouseZoneNullSectionNum: failed to DROP DEFAULT on section_num — skipping");
  }
  try {
    // Null out any leftover sentinel rows (section_num <= 0) that were used
    // during the old auto-number migration and should never appear in the UI.
    await db.execute(sql`
      UPDATE warehouse_zone
         SET section_num = NULL
       WHERE section_num IS NOT NULL
         AND section_num <= 0
    `);
  } catch (err) {
    logger.error({ err }, "Failed to null-migrate warehouse_zone sentinel section_nums");
  }
}

async function migrateUsersTable(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        clerk_user_id TEXT PRIMARY KEY,
        email         TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'pending',
        role          TEXT NOT NULL DEFAULT 'user',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Add the role column to pre-existing users tables that lack it.
    await db.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
    `);
  } catch (err) {
    logger.error({ err }, "Failed to migrate users table");
  }

  // Deduplicate rows with the same email address, keeping the row with the
  // highest combined role+status priority (admin > user, approved > pending > banned).
  // This is a one-time idempotent migration; re-runs are harmless.
  try {
    await db.execute(sql`
      DELETE FROM users
      WHERE clerk_user_id IN (
        SELECT clerk_user_id
        FROM (
          SELECT
            clerk_user_id,
            email,
            ROW_NUMBER() OVER (
              PARTITION BY email
              ORDER BY
                CASE role   WHEN 'admin' THEN 0 ELSE 1 END,
                CASE status WHEN 'approved' THEN 0
                            WHEN 'pending'  THEN 1
                            ELSE                 2 END,
                created_at ASC
            ) AS rn
          FROM users
          WHERE email <> ''
        ) ranked
        WHERE rn > 1
      )
    `);
  } catch (err) {
    logger.error({ err }, "Failed to deduplicate users by email");
  }

  // Add a partial unique index on email (excluding empty strings) so future
  // duplicates are prevented at the DB level without blocking users whose email
  // could not be resolved from Clerk (stored as ''). IF NOT EXISTS makes re-runs safe.
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_email_unique
        ON users (email)
       WHERE email <> ''
    `);
  } catch (err) {
    logger.error({ err }, "Failed to add users_email_unique partial index");
  }
}

const STARTUP_MIGRATIONS_TIMEOUT_MS = 25_000;
const migrationsTimeout = new Promise<void>((resolve) =>
  setTimeout(() => {
    logger.warn(
      { timeoutMs: STARTUP_MIGRATIONS_TIMEOUT_MS },
      "Startup migrations exceeded time limit — proceeding to startServer anyway",
    );
    resolve();
  }, STARTUP_MIGRATIONS_TIMEOUT_MS),
);

const INIT_PROVIDER_TIMEOUT_MS = 8_000;

function withStartupTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | void> {
  return Promise.race([
    promise,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        logger.warn({ timeoutMs, label }, `Startup step timed out — proceeding anyway`);
        resolve();
      }, timeoutMs),
    ),
  ]);
}

Promise.race([
  Promise.all([recoverOrphanedJobs(), initQuickLookupCache(), migrateAdminPreferences(), migrateWarehouseZoneNullSectionNum(), checkZoneSectionNumIntegrity(), migrateUsersTable()]),
  migrationsTimeout,
])
  .then(() => withStartupTimeout(initProvider(), INIT_PROVIDER_TIMEOUT_MS, "initProvider"))
  .then(() => startServer(app, port, MAX_RETRIES))
  .then((server) => {
    const shutdown = (signal: string) => {
      logger.info({ signal }, "Received shutdown signal — draining in-flight requests");
      server.close(() => {
        logger.info("Server closed — exiting cleanly");
        process.exit(0);
      });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Probe Poe bots in the background — must not block port open.
    probePoeBotsOnStartup().catch((err) => {
      logger.error({ err }, "Poe bot startup probe failed");
    });
  })
  .catch((err) => {
    logger.error({ err }, "Fatal error during server startup — exiting");
    process.exit(1);
  });
