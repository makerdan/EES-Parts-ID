/**
 * Database helpers for integration tests.
 * Inserts clearly-labelled fixture rows and removes them after the suite.
 */

import {
  abbreviationMapTable,
  db,
  electricalSlangMapTable,
  inventoryTable,
  misspellingMapTable,
  pool,
  synonymMapTable,
  usersTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const TEST_WORKER_INSTANCE = `${process.pid}-${process.env.JEST_WORKER_ID ?? "single"}`;

/**
 * Qualify a test identity with the current Jest worker and Node process.
 *
 * The process component distinguishes simultaneous Jest invocations of the
 * same suite; the worker component distinguishes workers within one
 * invocation. Callers must pass the resulting id to cleanupTestUser so
 * cleanup remains exact and owned by this suite.
 */
export function workerQualifiedUserId(
  baseId: string,
  workerInstance = TEST_WORKER_INSTANCE,
): string {
  return `${baseId}-${workerInstance}`;
}

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
  const fixtureTimestamp = new Date("2025-01-01T00:00:00.000Z");
  const rows = await db
    .insert(inventoryTable)
    .values(
      items.map(i => ({
        vendor: i.vendor.toUpperCase(),
        catalog: i.catalog,
        orderPurchase: 0,
        orderQuantity: 0,
        description: i.description,
        binLocations: i.binLocations ?? [],
        aiKeywords: [] as string[],
        createdAt: fixtureTimestamp,
        updatedAt: fixtureTimestamp,
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
 * Seed the dictionary rows asserted by dictionaries.integration.test.ts.
 *
 * Each insert is an idempotent upsert so the suite is deterministic on an
 * empty test database without replacing canonical development seed values.
 */
export interface DictionaryFixtures {
  abbreviation: string;
  synonym: string;
  misspelling: string;
  correction: string;
  slang: string;
}

export function dictionaryFixturesForWorker(
  workerInstance = TEST_WORKER_INSTANCE,
): DictionaryFixtures {
  const suffix = workerInstance.toLowerCase();
  return {
    abbreviation: `jest-ser-${suffix}`,
    synonym: `jest-afci-${suffix}`,
    misspelling: `jest-gcfi-${suffix}`,
    correction: `jest-gfci-${suffix}`,
    slang: `jest-stab-in-${suffix}`,
  };
}

export async function seedDictionaryFixtures(
  workerInstance = TEST_WORKER_INSTANCE,
): Promise<DictionaryFixtures> {
  const fixtures = dictionaryFixturesForWorker(workerInstance);
  // Some long-lived test databases retain the legacy dictionary-version
  // triggers even though Drizzle no longer owns their support table. Keep that
  // test-only compatibility state deterministic so owned fixture writes work
  // on both fresh and previously provisioned databases.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS dictionary_version (
      id integer PRIMARY KEY,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db
    .insert(abbreviationMapTable)
    .values({
      abbreviation: fixtures.abbreviation,
      expansions: ["service entrance rated", "service entrance cable"],
      category: "jest-fixture",
    })
    .onConflictDoNothing();
  await db
    .insert(synonymMapTable)
    .values({
      term: fixtures.synonym,
      synonyms: ["arc fault circuit interrupter"],
      category: "jest-fixture",
    })
    .onConflictDoNothing();
  await db
    .insert(misspellingMapTable)
    .values({ misspelling: fixtures.misspelling, correction: fixtures.correction })
    .onConflictDoNothing();
  await db
    .insert(electricalSlangMapTable)
    .values({
      slangTerm: fixtures.slang,
      standardTerms: ["push-in connector", "backstab connector"],
      category: "jest-fixture",
      notes: "Owned by the dictionary integration suite when not already seeded.",
    })
    .onConflictDoNothing();
  return fixtures;
}

export async function cleanupDictionaryFixtures(
  workerInstance = TEST_WORKER_INSTANCE,
): Promise<void> {
  const fixtures = dictionaryFixturesForWorker(workerInstance);
  await db
    .delete(abbreviationMapTable)
    .where(eq(abbreviationMapTable.abbreviation, fixtures.abbreviation));
  await db.delete(synonymMapTable).where(eq(synonymMapTable.term, fixtures.synonym));
  await db
    .delete(misspellingMapTable)
    .where(eq(misspellingMapTable.misspelling, fixtures.misspelling));
  await db
    .delete(electricalSlangMapTable)
    .where(eq(electricalSlangMapTable.slangTerm, fixtures.slang));
}

/**
 * Explicit pool shutdown is retained only for standalone tooling that owns
 * the process. Jest integration suites must not call this: the pool is shared
 * across files and remains available until the worker exits.
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

export function editableCatalogForWorker(
  workerInstance = TEST_WORKER_INSTANCE,
): string {
  return workerQualifiedUserId("JEST-EDIT-ITEM-001", workerInstance);
}

/**
 * Insert a single item with a full set of mutable fields for edit integration
 * tests. Returns the row with its generated `id`.
 *
 * The item is cleaned up by calling `cleanupEditableItem()`.
 */
export async function seedEditableItem(
  workerInstance = TEST_WORKER_INSTANCE,
): Promise<EditableItem> {
  const catalog = editableCatalogForWorker(workerInstance);
  await db.delete(inventoryTable).where(eq(inventoryTable.catalog, catalog));

  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: "JEST-EDIT-VENDOR",
      catalog,
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
export async function cleanupEditableItem(
  workerInstance = TEST_WORKER_INSTANCE,
): Promise<void> {
  await db
    .delete(inventoryTable)
    .where(eq(inventoryTable.catalog, editableCatalogForWorker(workerInstance)));
}

/** Convenience: standard fixtures used across multiple suites. */
export function standardFixtureCatalogsForWorker(
  workerInstance = TEST_WORKER_INSTANCE,
) {
  return {
    breaker: workerQualifiedUserId("JEST-ITG-BR120", workerInstance),
    receptacle: workerQualifiedUserId("JEST-ITG-HBL5262I", workerInstance),
  } as const;
}

export function standardFixturesForWorker(
  workerInstance = TEST_WORKER_INSTANCE,
): FixtureItem[] {
  const catalogs = standardFixtureCatalogsForWorker(workerInstance);
  return [
    {
      vendor: "EATON",
      catalog: catalogs.breaker,
      description: "1 Pole 20A 120/240V Breaker",
      binLocations: ["B-01"],
    },
    {
      vendor: "HUBBELL",
      catalog: catalogs.receptacle,
      description: "20A 125V Duplex Receptacle Ivory",
      binLocations: ["C-07"],
    },
  ];
}

export const STANDARD_FIXTURE_CATALOGS = standardFixtureCatalogsForWorker();
export const STANDARD_FIXTURES = standardFixturesForWorker();
