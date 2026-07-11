/**
 * Database helpers for integration tests.
 * Inserts clearly-labelled fixture rows and removes them after the suite.
 */

import { db, pool, inventoryTable } from "@workspace/db";
import { sql } from "drizzle-orm";

/** All fixture catalog numbers inserted by this helper (for cleanup). */
const FIXTURE_CATALOG_PREFIX = "JEST-ITG-";

export interface FixtureItem {
  vendor: string;
  catalog: string;
  description: string;
  binLocations?: string[];
  dimensions?: {
    length?: number | null;
    width?: number | null;
    height?: number | null;
    diameter?: number | null;
  } | null;
}

/**
 * Insert fixture rows into the inventory table.
 * Returns the actual inserted rows (with generated ids).
 */
export async function seedFixtures(items: FixtureItem[]) {
  const rows = await db
    .insert(inventoryTable)
    .values(
      items.map(i => ({
        vendor: i.vendor.toUpperCase(),
        catalog: i.catalog,
        description: i.description,
        binLocations: i.binLocations ?? [],
        aiKeywords: [] as string[],
        ...(i.dimensions !== undefined ? { dimensions: i.dimensions } : {}),
      })),
    )
    .onConflictDoNothing()
    .returning();
  return rows;
}

/**
 * Remove all rows whose catalog starts with the JEST-ITG- prefix.
 * Safe to call even if nothing was seeded.
 */
export async function cleanupFixtures() {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${FIXTURE_CATALOG_PREFIX + "%"}`);
}

/**
 * Close the shared PostgreSQL pool so Jest can exit cleanly.
 * Idempotent — safe to call from multiple test files in the same worker
 * process (pool.end() throws if called twice; this guard prevents that).
 * Jest's `forceExit: true` ensures the process terminates even if the pool
 * lingers, so callers do not need to guarantee this runs at all.
 */
let _poolEnded = false;
export async function closePool() {
  if (_poolEnded) return;
  _poolEnded = true;
  await pool.end();
}

/** Convenience: standard fixtures used across multiple suites. */
export const STANDARD_FIXTURES: FixtureItem[] = [
  {
    vendor: "EATON",
    catalog: "JEST-ITG-BR120",
    description: "1 Pole 20A 120/240V Breaker",
    binLocations: ["B-01"],
  },
  {
    vendor: "HUBBELL",
    catalog: "JEST-ITG-HBL5262I",
    description: "20A 125V Duplex Receptacle Ivory",
    binLocations: ["C-07"],
  },
];
