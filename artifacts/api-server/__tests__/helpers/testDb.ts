/**
 * Database helpers for integration tests.
 * Inserts clearly-labelled fixture rows and removes them after the suite.
 */

import { db, pool, inventoryTable, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

/**
 * Seed (or update) a test user row, race-safe under parallel Jest workers.
 *
 * Hardening against `users_email_unique` duplicate-key races: the email is
 * DERIVED from the clerkUserId (`<clerkUserId>@jest.test.example`), so two
 * different suites can never collide on the same email, and re-seeding the
 * same user from concurrent workers upserts idempotently on clerk_user_id.
 * Never pass a hand-written shared email here.
 */
type UserInsert = typeof usersTable.$inferInsert;

export async function seedTestUser(opts: {
  clerkUserId: UserInsert["clerkUserId"] & string;
  status?: UserInsert["status"];
  role?: UserInsert["role"];
}): Promise<void> {
  const { clerkUserId, status = "approved", role = "user" } = opts;
  await db
    .insert(usersTable)
    .values({
      clerkUserId,
      email: `${clerkUserId.toLowerCase()}@jest.test.example`,
      status,
      role,
    })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { status, role },
    });
}

/** Remove a user seeded by seedTestUser. Idempotent. */
export async function cleanupTestUser(clerkUserId: string): Promise<void> {
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, clerkUserId));
}

/**
 * Catalog numbers seeded by THIS module instance (i.e. this Jest worker).
 * cleanupFixtures() deletes only these rows — never a blanket
 * `LIKE 'JEST-ITG-%'` — so a suite tearing down in one worker cannot wipe
 * fixtures that a different suite is actively using in a parallel worker.
 */
const _seededCatalogs = new Set<string>();

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
  for (const i of items) _seededCatalogs.add(i.catalog);
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
 * Remove the fixture rows seeded by THIS worker's seedFixtures() calls.
 * Safe to call even if nothing was seeded (no-op).
 *
 * IMPORTANT: this deliberately does NOT delete every `JEST-ITG-%` row.
 * Suites run in parallel Jest workers against a shared database; a blanket
 * prefix delete from one suite's beforeAll/afterAll silently wipes fixtures
 * another suite is mid-way through using, producing flaky
 * "fixture JEST-ITG-… not found" failures. Because seedFixtures() uses
 * onConflictDoNothing(), stale leftovers from a crashed previous run are
 * harmless — re-seeding the same catalog simply reuses the existing row.
 */
export async function cleanupFixtures() {
  if (_seededCatalogs.size === 0) return;
  const catalogs = [..._seededCatalogs];
  _seededCatalogs.clear();
  await db
    .delete(inventoryTable)
    .where(
      sql`${inventoryTable.catalog} IN (${sql.join(
        catalogs.map((c) => sql`${c}`),
        sql`, `,
      )})`,
    );
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
  // Suites that jest.mock("@workspace/db") get a mocked module where `pool`
  // is undefined (or a mock without end()); there is no real pool to close.
  if (!pool || typeof pool.end !== "function") return;
  // pg's Pool.end() throws if called twice. The _poolEnded flag guards the
  // common case, but a second module instance (e.g. after jest.resetModules)
  // can still race a pool that was already ended elsewhere — swallow that.
  const p = pool as unknown as { ended?: boolean; ending?: boolean };
  if (p.ended || p.ending) return;
  try {
    await pool.end();
  } catch (err) {
    if (err instanceof Error && /end.*(twice|more than once)/i.test(err.message)) return;
    throw err;
  }
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
