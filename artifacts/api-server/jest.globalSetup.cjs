/**
 * Jest globalSetup — runs once before the entire test suite.
 *
 * 1. Preflight health-check: opens a single pg connection and runs SELECT 1
 *    to confirm the pool is reachable.  If it is not, the suite exits
 *    immediately with a clear "DB pool unreachable" message instead of
 *    hanging until the 20s per-test integration timeout fires 30+ times.
 *
 * 2. Schema sync: pushes the current Drizzle schema to the test database so
 *    that any columns or tables added since the DB was last synced are present
 *    before tests run.  This prevents cryptic "column does not exist" failures
 *    inside individual test assertions.
 *
 * The DATABASE_URL env var must already be set (same one used by the tests).
 *
 * Uses `drizzle-kit push --force` (non-interactive schema sync) rather than
 * `drizzle migrate`, because this project tracks schema through drizzle push,
 * not through migration SQL files.
 */

const { execSync } = require("child_process");
const path = require("path");
const { Client } = require("pg");

const DB_PREFLIGHT_TIMEOUT_MS = 5_000;
// 120s: drizzle-kit push normally takes a few seconds, but under heavy
// concurrent load (e.g. ~20 validation commands running in parallel after a
// task merge) it has been observed to exceed 30s even with a reachable DB.
const DRIZZLE_PUSH_TIMEOUT_MS = 120_000;

async function checkDbReachable() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: DB_PREFLIGHT_TIMEOUT_MS,
    statement_timeout: DB_PREFLIGHT_TIMEOUT_MS,
  });

  const timer = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("timed out")),
      DB_PREFLIGHT_TIMEOUT_MS
    )
  );

  await Promise.race([
    (async () => {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
    })(),
    timer,
  ]).catch(async (err) => {
    await client.end().catch(() => {});
    throw err;
  });
}

module.exports = async function globalSetup() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "[jest globalSetup] DATABASE_URL is not set — cannot sync test DB schema."
    );
  }

  // ── 1. Preflight health-check ─────────────────────────────────────────────
  try {
    await checkDbReachable();
    console.log("[jest globalSetup] DB pool reachable (SELECT 1 OK).");
  } catch (err) {
    throw new Error(
      "[jest globalSetup] DB pool unreachable — aborting test run.\n" +
        "  Reason : " +
        err.message +
        "\n" +
        "  Fix    : check DATABASE_URL connectivity and that the DB server is running.\n" +
        "  (Skipping test run to avoid hanging on every integration test.)"
    );
  }

  // ── 1b. Reset rate-limiter state ──────────────────────────────────────────
  // The sliding-window rate limiter persists per-key hit windows in the
  // rate_limit_buckets table of this same (dev) database. Leftover rows from a
  // previous test run (or from the dev server) would make suites hit 429s that
  // have nothing to do with the code under test, so clear the table up front.
  try {
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: DB_PREFLIGHT_TIMEOUT_MS,
    });
    await client.connect();
    await client.query("DELETE FROM rate_limit_buckets");
    await client.end();
    console.log("[jest globalSetup] rate_limit_buckets cleared.");
  } catch (err) {
    // Table may not exist yet before the schema sync below — not fatal.
    console.warn(
      "[jest globalSetup] could not clear rate_limit_buckets: " + err.message
    );
  }

  // ── 2. Schema sync ────────────────────────────────────────────────────────
  const dbPackageDir = path.resolve(__dirname, "../../lib/db");

  try {
    execSync(
      "pnpm exec drizzle-kit push --force --config ./drizzle.config.ts",
      {
        cwd: dbPackageDir,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: DRIZZLE_PUSH_TIMEOUT_MS,
      }
    );
    console.log("[jest globalSetup] Test DB schema is up to date.");
  } catch (err) {
    if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
      throw new Error(
        `[jest globalSetup] drizzle-kit push exceeded ${DRIZZLE_PUSH_TIMEOUT_MS / 1000}s — check DATABASE_URL` +
          " connectivity and that the DB server is reachable."
      );
    }
    const details =
      (err.stderr && err.stderr.toString().trim()) ||
      (err.stdout && err.stdout.toString().trim()) ||
      err.message;
    console.error(
      "[jest globalSetup] drizzle-kit push failed — fix the DB schema before running tests.\n" +
        details
    );
    throw new Error(
      "[jest globalSetup] Schema sync failed. See output above for details."
    );
  }
};
