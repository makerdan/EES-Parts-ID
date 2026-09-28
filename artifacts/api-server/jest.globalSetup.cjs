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
const { readFileSync } = require("fs");
const path = require("path");
const { Client } = require("pg");

const DB_PREFLIGHT_TIMEOUT_MS = 5_000;
// 120s: drizzle-kit push normally takes a few seconds, but under heavy
// concurrent load (e.g. ~20 validation commands running in parallel after a
// task merge) it has been observed to exceed 30s even with a reachable DB.
const DRIZZLE_PUSH_TIMEOUT_MS = 120_000;
const RETIRED_DICTIONARY_TRIGGER_NAMES = [
  "trg_dict_ver_synonym_group",
  "trg_dict_ver_abbreviation_map",
  "trg_dict_ver_electrical_slang_map",
  "trg_dict_ver_misspelling_map",
];
const INVENTORY_CHIP_TEXT_SIGNATURE = "inventory_chip_text(text,text,text,text[])";
const INVENTORY_CHIP_TEXT_SQL_PATH = path.resolve(
  __dirname,
  "../../lib/db/drizzle/inventory_chip_text.sql"
);

async function removeRetiredDictionaryVersionObjects(client) {
  const { rows } = await client.query(
    `
      SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND t.tgname = ANY($1::text[])
    `,
    [RETIRED_DICTIONARY_TRIGGER_NAMES]
  );

  for (const row of rows) {
    await client.query(
      `DROP TRIGGER IF EXISTS ${quoteIdentifier(row.trigger_name)} ON ${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.table_name)}`
    );
  }

  await client.query("DROP FUNCTION IF EXISTS increment_dict_version()");
  return rows.length;
}

async function removeUnusedDictionaryVersionTables(
  client,
  databaseEnvironment = process.env.DATABASE_ENV
) {
  if (databaseEnvironment?.trim().toLowerCase() !== "test") {
    throw new Error(
      "DATABASE_ENV=test is required to remove obsolete dictionary-version tables."
    );
  }

  const { rows } = await client.query(`
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      EXISTS (
        SELECT 1
        FROM pg_trigger t
        WHERE t.tgrelid = c.oid
          AND NOT t.tgisinternal
      ) AS has_user_trigger,
      EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.refobjid = c.oid
          AND d.deptype NOT IN ('a', 'i')
          AND d.objid <> c.oid
      ) AS has_external_dependency
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'dictionary_version'
      AND c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  `);

  let removedCount = 0;
  let retainedCount = 0;

  for (const row of rows) {
    if (row.has_user_trigger || row.has_external_dependency) {
      retainedCount += 1;
      continue;
    }

    // Do not use CASCADE here. If a dependency appears after the inspection
    // query, PostgreSQL must reject the drop and preserve the dependent
    // object instead of allowing cleanup to break it.
    try {
      await client.query(
        `DROP TABLE ${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.table_name)}`
      );
      removedCount += 1;
    } catch (error) {
      if (error?.code === "2BP01") {
        retainedCount += 1;
        continue;
      }
      throw error;
    }
  }

  let status = "absent";
  if (retainedCount > 0) {
    status = "retained";
  } else if (removedCount > 0) {
    status = "removed";
  }

  return {
    status,
    removedCount,
    retainedCount,
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function closeClient(client) {
  if (!client || typeof client.end !== "function") {
    return;
  }

  try {
    await client.end();
  } catch (error) {
    console.warn(
      `[jest globalSetup] Could not close a PostgreSQL client: ${error?.message ?? String(error)}`
    );
  }
}

async function cleanupTemporarySchema(client, schemaName, schemaCreated = true) {
  if (schemaCreated && client && typeof client.query === "function") {
    try {
      await client.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`
      );
    } catch (error) {
      console.warn(
        `[jest globalSetup] Could not remove temporary schema ${schemaName}: ${error?.message ?? String(error)}`
      );
    }
  }

  await closeClient(client);
}

async function provisionInventoryChipText(client) {
  let sql;
  try {
    sql = readFileSync(INVENTORY_CHIP_TEXT_SQL_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `[jest globalSetup] Could not read inventory_chip_text provisioning SQL at ${INVENTORY_CHIP_TEXT_SQL_PATH}: ${err.message}`
    );
  }

  await client.query(sql);
}

async function verifyInventoryChipText(client) {
  const { rows } = await client.query(
    "SELECT to_regprocedure($1)::text AS signature",
    [INVENTORY_CHIP_TEXT_SIGNATURE]
  );
  const signature = rows[0]?.signature ?? null;
  if (signature !== INVENTORY_CHIP_TEXT_SIGNATURE) {
    throw new Error(
      `[jest globalSetup] inventory_chip_text verification failed: expected ${INVENTORY_CHIP_TEXT_SIGNATURE}, resolved ${signature ?? "NULL"}`
    );
  }
}

async function checkDbReachable() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: DB_PREFLIGHT_TIMEOUT_MS,
    statement_timeout: DB_PREFLIGHT_TIMEOUT_MS,
  });

  let timer;
  try {
    const operation = (async () => {
      await client.connect();
      await client.query("SELECT 1");
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("timed out")),
        DB_PREFLIGHT_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    await closeClient(client);
  }
}

module.exports = async function globalSetup() {
  const databaseEnvironment = process.env.DATABASE_ENV?.trim().toLowerCase();
  if (databaseEnvironment !== "test") {
    throw new Error(
      "[jest globalSetup] DATABASE_ENV=test is required — refusing to run tests against a non-test database."
    );
  }

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
  let rateLimitClient;
  try {
    rateLimitClient = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: DB_PREFLIGHT_TIMEOUT_MS,
    });
    await rateLimitClient.connect();
    await rateLimitClient.query("DELETE FROM rate_limit_buckets");
    console.log("[jest globalSetup] rate_limit_buckets cleared.");
  } catch (err) {
    // Table may not exist yet before the schema sync below — not fatal.
    console.warn(
      "[jest globalSetup] could not clear rate_limit_buckets: " + err.message
    );
  } finally {
    await closeClient(rateLimitClient);
  }

  // ── 2. Schema sync ────────────────────────────────────────────────────────
  const dbPackageDir = path.resolve(__dirname, "../../lib/db");

  const cleanupClient = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: DB_PREFLIGHT_TIMEOUT_MS,
  });
  try {
    await cleanupClient.connect();
    const removedTriggerCount =
      await removeRetiredDictionaryVersionObjects(cleanupClient);
    const dictionaryTableCleanup =
      await removeUnusedDictionaryVersionTables(cleanupClient);
    console.log(
      `[jest globalSetup] retired dictionary-version cleanup: ${dictionaryTableCleanup.status} (${removedTriggerCount} triggers removed, ${dictionaryTableCleanup.removedCount} tables removed, ${dictionaryTableCleanup.retainedCount} tables retained).`
    );
  } finally {
    await closeClient(cleanupClient);
  }

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

  const functionClient = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: DB_PREFLIGHT_TIMEOUT_MS,
  });
  try {
    await functionClient.connect();
    await provisionInventoryChipText(functionClient);
    await verifyInventoryChipText(functionClient);
    console.log(
      `[jest globalSetup] ${INVENTORY_CHIP_TEXT_SIGNATURE} is installed and verified.`
    );
  } catch (err) {
    throw new Error(
      "[jest globalSetup] Failed to provision or verify inventory_chip_text before tests.\n" +
        `  Reason : ${err.message}\n` +
        "  Fix    : check the shared SQL contract and test database permissions."
    );
  } finally {
    await closeClient(functionClient);
  }
};

module.exports.removeRetiredDictionaryVersionObjects =
  removeRetiredDictionaryVersionObjects;
module.exports.removeUnusedDictionaryVersionTables =
  removeUnusedDictionaryVersionTables;
module.exports.cleanupTemporarySchema = cleanupTemporarySchema;
module.exports.provisionInventoryChipText = provisionInventoryChipText;
module.exports.verifyInventoryChipText = verifyInventoryChipText;
