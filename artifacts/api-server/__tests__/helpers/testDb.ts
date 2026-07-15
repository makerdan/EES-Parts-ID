/**
 * Database helpers for integration tests.
 * Inserts clearly-labelled fixture rows and removes them after the suite.
 */

import { db, pool, inventoryTable } from "@workspace/db";
import { eq, like, sql } from "drizzle-orm";

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
 *
 * jest.integrationSetup.cjs registers a global afterAll that calls this
 * function after every test file, so individual test files rarely need to
 * import or call closePool() directly. Only use it in special cases where
 * the global teardown order is insufficient.
 */
let _poolEnded = false;
export async function closePool() {
  if (_poolEnded) return;
  _poolEnded = true;
  await pool.end();
}

export interface EditableItem {
  id: number;
  vendor: string;
  catalog: string;
  description: string;
  binLocations: string[];
  aiKeywords: string[];
  barcodes: string[];
  dimensions: {
    length: number | null;
    width: number | null;
    height: number | null;
    diameter: number | null;
  } | null;
  expandedDescription: string | null;
}

const EDITABLE_CATALOG = "JEST-EDIT-ITEM-001";

/**
 * Insert a single item with a full set of mutable fields for edit integration
 * tests. Returns the row with its generated `id`.
 *
 * The item is cleaned up by calling `cleanupEditableItem()`.
 */
export async function seedEditableItem(): Promise<EditableItem> {
  await db.delete(inventoryTable).where(eq(inventoryTable.catalog, EDITABLE_CATALOG));

  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: "JEST-EDIT-VENDOR",
      catalog: EDITABLE_CATALOG,
      description: "Original editable description",
      binLocations: ["EDIT-BIN-01", "EDIT-BIN-02"],
      aiKeywords: ["relay", "motor"],
      barcodes: ["012345678901"],
      dimensions: { length: 100, width: 50, height: 25, diameter: null },
      expandedDescription: "Original expanded description text for testing.",
    })
    .returning();

  if (!row) throw new Error("seedEditableItem: insert returned no rows");

  return {
    id: row.id,
    vendor: row.vendor,
    catalog: row.catalog,
    description: row.description,
    binLocations: row.binLocations,
    aiKeywords: row.aiKeywords,
    barcodes: (row as unknown as { barcodes?: string[] }).barcodes ?? [],
    dimensions: row.dimensions as EditableItem["dimensions"],
    expandedDescription: row.expandedDescription ?? null,
  };
}

/** Remove the editable item seeded by seedEditableItem. Idempotent. */
export async function cleanupEditableItem(): Promise<void> {
  // Guard: if the pool was already closed (e.g. by the db-serial project's
  // global teardown before the parallel project's afterAll runs), skip silently.
  if (_poolEnded) return;
  await pool.query("DELETE FROM inventory WHERE catalog = $1", [EDITABLE_CATALOG]);
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
