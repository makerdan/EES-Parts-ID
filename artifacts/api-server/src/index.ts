import { adminAuditLogTable, catalogPdfJobTable, db } from "@workspace/db";
import { eq, lt, sql } from "drizzle-orm";

import app from "./app";
import { initProvider, probePoeBotsOnStartup } from "./lib/aiProvider";
import { logger } from "./lib/logger";
import {
  pruneScreenViewLog,
  SCREEN_VIEW_RETENTION_INTERVAL_MS,
} from "./lib/screenViewRetention";
import { startServer } from "./lib/startServer";
import { validateEnv } from "./lib/validateEnv";
import { applyZoneSectionNumFix } from "./lib/zoneSectionNumFix";
import { shutdownCatalogPdfLoops } from "./routes/catalogPdf";

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — exiting");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — exiting");
  process.exit(1);
});

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : NaN;
const isDev = process.env.NODE_ENV !== "production";

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(
    rawPort
      ? `Invalid PORT value: "${rawPort}"`
      : "PORT environment variable is required but was not provided.",
  );
}

validateEnv();

if (process.env["SKIP_ADMIN_MFA"] === "true" && isDev) {
  logger.warn(
    { SKIP_ADMIN_MFA: "true" },
    "Admin MFA enforcement is DISABLED (SKIP_ADMIN_MFA=true) — admin accounts are not protected by MFA",
  );
}

async function recoverOrphanedJobs(): Promise<void> {
  try {
    const result = await db
      .update(catalogPdfJobTable)
      .set({
        status: "failed",
        errorMessage: "Server restarted while job was in progress. Use Resume to continue from the last processed page.",
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
// unref(): these are fallback timers only — they must never be the thing
// keeping the process (or a Jest worker) alive after everything else is done.
const migrationsTimeout = new Promise<void>((resolve) =>
  setTimeout(() => {
    logger.warn(
      { timeoutMs: STARTUP_MIGRATIONS_TIMEOUT_MS },
      "Startup migrations exceeded time limit — proceeding to startServer anyway",
    );
    resolve();
  }, STARTUP_MIGRATIONS_TIMEOUT_MS).unref(),
);

const INIT_PROVIDER_TIMEOUT_MS = 8_000;

function withStartupTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn({ timeoutMs, label }, `Startup step timed out — proceeding anyway`);
        resolve();
      }, timeoutMs);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// ── Audit log retention ───────────────────────────────────────────────────────
// Deletes admin_audit_log rows older than AUDIT_LOG_RETENTION_DAYS (default 90).
// Runs once at startup and then every 24 hours.
const AUDIT_LOG_RETENTION_DAYS = Math.max(
  1,
  Number(process.env["AUDIT_LOG_RETENTION_DAYS"] ?? 90) || 90,
);
const AUDIT_LOG_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function pruneAuditLog(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(adminAuditLogTable)
      .where(lt(adminAuditLogTable.createdAt, cutoff))
      .returning({ id: adminAuditLogTable.id });
    if (deleted.length > 0) {
      logger.info(
        { count: deleted.length, retentionDays: AUDIT_LOG_RETENTION_DAYS },
        "Pruned old audit log rows",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to prune audit log");
  }
}

Promise.race([
  Promise.all([recoverOrphanedJobs(), initQuickLookupCache(), migrateAdminPreferences(), migrateWarehouseZoneNullSectionNum(), applyZoneSectionNumFix(), migrateUsersTable()]),
  migrationsTimeout,
])
  .then(() => withStartupTimeout(initProvider(), INIT_PROVIDER_TIMEOUT_MS, "initProvider"))
  // The dev workflow has already performed the canonical stale-holder sweep.
  // Do not retry or silently move the listener after a conflict: the startup
  // error must identify the owner and the recovery command.
  .then(() => startServer(app, port, 0))
  .then((server) => {
    // Hard cap on total shutdown time: if draining hangs (slow AI call, DB
    // stall), force-exit so the platform doesn't have to SIGKILL us.
    const SHUTDOWN_HARD_LIMIT_MS = 20_000;
    // Bounded wait for background catalog-pdf loops to stop at a page boundary
    // and be marked with a resumable status.
    const PDF_LOOP_DRAIN_TIMEOUT_MS = 10_000;

    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, "Received shutdown signal — draining in-flight requests");

      setTimeout(() => {
        logger.warn({ hardLimitMs: SHUTDOWN_HARD_LIMIT_MS }, "Shutdown hard limit reached — forcing exit");
        process.exit(0);
      }, SHUTDOWN_HARD_LIMIT_MS).unref();

      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      // Stop background PDF loops (marks in-flight jobs resumable) while the
      // HTTP server drains, then exit once both are done.
      Promise.allSettled([
        shutdownCatalogPdfLoops(PDF_LOOP_DRAIN_TIMEOUT_MS),
        serverClosed,
      ]).then(() => {
        logger.info("Server closed and background loops drained — exiting cleanly");
        process.exit(0);
      });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Probe Poe bots in the background — must not block port open.
    probePoeBotsOnStartup().catch((err) => {
      logger.error({ err }, "Poe bot startup probe failed");
    });

    // Schedule retention independently of incoming telemetry traffic.
    pruneAuditLog();
    setInterval(pruneAuditLog, AUDIT_LOG_RETENTION_INTERVAL_MS).unref();
    pruneScreenViewLog();
    setInterval(pruneScreenViewLog, SCREEN_VIEW_RETENTION_INTERVAL_MS).unref();
  })
  .catch((err) => {
    logger.error({ err }, "Fatal error during server startup — exiting");
    process.exit(1);
  });
