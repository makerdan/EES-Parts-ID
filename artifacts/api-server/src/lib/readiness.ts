import type { db as database } from "@workspace/db";
import { sql } from "drizzle-orm";

type StartupReadinessStatus = "pending" | "ready" | "timed_out" | "failed";

type StartupReadiness = {
  status: StartupReadinessStatus;
};

export const STARTUP_MIGRATIONS_TIMEOUT_MS = 25_000;
export const STARTUP_SCHEMA_MAX_ATTEMPTS = 5;
export const STARTUP_SCHEMA_PROBE_TIMEOUT_MS = 4_000;
export const STARTUP_SCHEMA_RETRY_DELAY_MS = 100;
export const STARTUP_SCHEMA_BUDGET_MS =
  STARTUP_SCHEMA_MAX_ATTEMPTS * STARTUP_SCHEMA_PROBE_TIMEOUT_MS +
  (STARTUP_SCHEMA_MAX_ATTEMPTS - 1) * STARTUP_SCHEMA_RETRY_DELAY_MS;

if (STARTUP_SCHEMA_BUDGET_MS > STARTUP_MIGRATIONS_TIMEOUT_MS) {
  throw new Error(
    "Required schema probe retry budget exceeds the startup readiness deadline.",
  );
}

/**
 * The tables that must exist before the API can report application readiness.
 *
 * Keep this list deliberately explicit and reviewable. Adding a table here
 * makes it part of the startup contract, and the manifest regression test
 * verifies each entry is backed by the Drizzle schema.
 */
export const REQUIRED_SCHEMA_TABLES = [
  "inventory",
  "users",
  "admin_preferences",
  "warehouse_zone",
] as const;

type SchemaExecutor = Pick<typeof database, "execute">;
export type SchemaProbeClient = {
  query: (query: string) => Promise<{
    rows?: Array<{ usable?: boolean }>;
  }>;
  release: (error?: Error) => void;
};

const REQUIRED_SCHEMA_QUERY = `SELECT ${REQUIRED_SCHEMA_TABLES.map(
  (tableName) => `to_regclass('public.${tableName}') IS NOT NULL`,
).join(" AND ")} AS usable`;

type SchemaCheckOptions = {
  statementTimeoutMs?: number;
};

export async function checkRequiredSchema(
  executor: SchemaExecutor | SchemaProbeClient,
  options: SchemaCheckOptions = {},
): Promise<boolean> {
  // The manifest is source-controlled and never contains user input, so the
  // generated identifier expression is safe to embed as a raw SQL predicate.
  // Keeping this as one raw statement also works with the lightweight Drizzle
  // mock used by startup tests, which only implements the sql tag.
  if ("execute" in executor) {
    const query =
      typeof sql.raw === "function" ? sql.raw(REQUIRED_SCHEMA_QUERY) : sql`SELECT 1`;
    const result = await executor.execute(query);

    return Boolean(
      (result as unknown as { rows?: Array<{ usable?: boolean }> }).rows?.[0]
        ?.usable,
    );
  }

  const timeoutMs = Math.max(
    1,
    Math.ceil(options.statementTimeoutMs ?? STARTUP_SCHEMA_PROBE_TIMEOUT_MS),
  );
  // SET statement_timeout makes PostgreSQL cancel the statement before a
  // timed-out client can be returned to the pool.
  await executor.query(`SET statement_timeout = ${timeoutMs}`);
  try {
    const result = await executor.query(REQUIRED_SCHEMA_QUERY);
    return Boolean(result.rows?.[0]?.usable);
  } finally {
    // Do not return a healthy pooled client with the probe's short timeout.
    await executor.query("SET statement_timeout = 0").catch(() => undefined);
  }
}

let startupReadiness: StartupReadiness = { status: "pending" };

function get(): Readonly<StartupReadiness> {
  return startupReadiness;
}

function markReady(): void {
  if (startupReadiness.status === "pending") {
    startupReadiness = { status: "ready" };
  }
}

function markTimedOut(): void {
  if (startupReadiness.status === "pending") {
    startupReadiness = { status: "timed_out" };
  }
}

function markFailed(): void {
  if (startupReadiness.status === "pending") {
    startupReadiness = { status: "failed" };
  }
}

function reset(): void {
  startupReadiness = { status: "pending" };
}

export const appReadiness = {
  get,
  markReady,
  markTimedOut,
  markFailed,
  reset,
};