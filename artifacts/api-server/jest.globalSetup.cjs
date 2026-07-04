/**
 * Jest globalSetup — runs once before the entire test suite.
 *
 * Pushes the current Drizzle schema to the test database so that any columns
 * or tables added since the DB was last synced are present before tests run.
 * This prevents cryptic "column does not exist" failures inside individual
 * test assertions — the error surfaces here instead, with a clear message.
 *
 * The DATABASE_URL env var must already be set (same one used by the tests).
 *
 * Uses `drizzle-kit push --force` (non-interactive schema sync) rather than
 * `drizzle migrate`, because this project tracks schema through drizzle push,
 * not through migration SQL files.
 */

const { execSync } = require("child_process");
const path = require("path");

module.exports = async function globalSetup() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "[jest globalSetup] DATABASE_URL is not set — cannot sync test DB schema."
    );
  }

  const dbPackageDir = path.resolve(__dirname, "../../lib/db");

  const DRIZZLE_PUSH_TIMEOUT_MS = 30_000;

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
        "[jest globalSetup] drizzle-kit push exceeded 30s — check DATABASE_URL" +
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
