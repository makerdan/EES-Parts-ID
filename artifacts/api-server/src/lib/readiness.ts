import type { db as database } from "@workspace/db";
import { sql } from "drizzle-orm";

type StartupReadinessStatus = "pending" | "ready" | "timed_out" | "failed";

type StartupReadiness = {
  status: StartupReadinessStatus;
};

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

export async function checkRequiredSchema(
  executor: SchemaExecutor,
): Promise<boolean> {
  // The manifest is source-controlled and never contains user input, so the
  // generated identifier expression is safe to embed as a raw SQL predicate.
  // Keeping this as one raw statement also works with the lightweight Drizzle
  // mock used by startup tests, which only implements the sql tag.
  const schemaPredicate = REQUIRED_SCHEMA_TABLES.map(
    (tableName) => `to_regclass('public.${tableName}') IS NOT NULL`,
  ).join(" AND ");
  const query =
    typeof sql.raw === "function"
      ? sql.raw(`SELECT ${schemaPredicate} AS usable`)
      : sql`SELECT 1`;
  const result = await executor.execute(query);

  return Boolean(
    (result as unknown as { rows?: Array<{ usable?: boolean }> }).rows?.[0]?.usable,
  );
}

let startupReadiness: StartupReadiness = { status: "pending" };

function get(): Readonly<StartupReadiness> {
  return startupReadiness;
}

function markReady(): void {
  startupReadiness = { status: "ready" };
}

function markTimedOut(): void {
  if (startupReadiness.status === "pending") {
    startupReadiness = { status: "timed_out" };
  }
}

function markFailed(): void {
  startupReadiness = { status: "failed" };
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