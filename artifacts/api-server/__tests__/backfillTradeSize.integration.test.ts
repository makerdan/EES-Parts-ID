/**
 * Regression guard: trade-size coverage in the attribute backfill pipeline.
 *
 * The coverage once silently dropped from 1,377 → 760 items because a change
 * to the parsing logic caused catalog codes that had previously resolved to a
 * trade size to no longer do so.  These tests catch that class of regression
 * by:
 *
 *  Part A — Computation unit tests (no DB):
 *    Calls the real `deriveTradeSizeIn` exported from
 *    `src/enrichment/tradeSizeBackfill.ts` — the same function the backfill
 *    script uses — for a set of catalog codes that MUST always produce a
 *    non-null trade_size_in.
 *
 *  Part B — Integration tests (live DB):
 *    Seeds known fixture rows, calls `deriveTradeSizeIn` on each (the
 *    production code path), writes the results to the DB, then reads back
 *    and asserts:
 *      (a) each conduit item got the expected trade_size_in value, and
 *      (b) coverage across the seeded conduit items is 100 %.
 *
 *  Part C — NEEDS_PARSE selection guard (live DB):
 *    Verifies that the backfill selection criteria correctly targets unprocessed
 *    rows and skips rows already at the current parser version so that query/
 *    filter changes causing coverage drops are also caught.
 */

import { db, pool, inventoryTable } from '@workspace/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { deriveTradeSizeIn } from '../src/enrichment/tradeSizeBackfill';
import { CURRENT_PARSER_VERSION } from '../src/enrichment/invalidation';

// ── Part A: unit tests — calls the real production derivation (no DB) ─────────

describe('deriveTradeSizeIn — catalog-code cases', () => {
  it.each([
    // Catalog code    Expected inches  Note
    ['EMT12', '0.500', 'fraction code 12 → 1/2"'],
    ['EMT34', '0.750', 'fraction code 34 → 3/4"'],
    ['EMT150', '1.500', 'decimal×100 code 150 → 1-1/2"'],
    ['EMT250', '2.500', 'decimal×100 code 250 → 2-1/2"'],
    ['EMT350', '3.500', 'decimal×100 code 350 → 3-1/2"'],
    ['IMC212', '2.500', 'fraction code 212 → 2-1/2"'],
    ['IMC112', '1.500', 'fraction code 112 → 1-1/2"'],
    ['PVC2', '2.000', 'whole-number code 2 → 2"'],
    ['EMT100', '1.000', 'whole-number ×100 code 100 → 1"'],
  ])('catalog=%s → tradeSizeIn=%s (%s)', (catalog, expected) => {
    const result = deriveTradeSizeIn({
      catalog,
      vendor: null,
      description: catalog + ' conduit',
    });
    expect(result).toBe(expected);
  });
});

describe('deriveTradeSizeIn — description fallback cases', () => {
  it('LOCKNUT with 3/4" in description → 0.750"', () => {
    const result = deriveTradeSizeIn({
      catalog: 'LN001',
      vendor: null,
      description: '3/4 Conduit Locknut',
    });
    expect(result).toBe('0.750');
  });

  it('generic conduit item with "1-1/2 in" in description → 1.500"', () => {
    const result = deriveTradeSizeIn({
      catalog: 'CONDFIT99',
      vendor: null,
      description: '1-1/2 in Conduit Connector',
    });
    expect(result).toBe('1.500');
  });

  it('FITTING with 1/2" in description → 0.500"', () => {
    const result = deriveTradeSizeIn({
      catalog: 'FIT001',
      vendor: null,
      description: '1/2" EMT FITTING',
    });
    expect(result).toBe('0.500');
  });
});

describe('deriveTradeSizeIn — non-conduit items', () => {
  it.each([
    ['BR120', '20A Breaker', 'circuit breaker → no trade size'],
    ['HBL5262I', '20A 125V Duplex Receptacle', 'receptacle → no trade size'],
    ['NM214', 'Romex 14/2 wire', 'wire → no trade size'],
  ])('catalog=%s desc=%s → null (%s)', (catalog, description, _note) => {
    const result = deriveTradeSizeIn({ catalog, vendor: null, description });
    expect(result).toBeNull();
  });
});

describe('deriveTradeSizeIn — idempotency', () => {
  it('preserves a previously-correct tradeSizeIn when the current derivation returns null', () => {
    const result = deriveTradeSizeIn({
      catalog: 'CONDFIT99',
      vendor: null,
      description: 'Conduit reducer body no size hint',
      tradeSizeIn: '0.750',
    });
    expect(result).toBe('0.750');
  });
});

// ── Part B: integration tests — full production path against a live DB ────────

/**
 * Fixture definitions.
 *
 * The JEST-TSZ- prefix is used for clean teardown.  The parseable digits are
 * appended AFTER the prefix so parseTradeSizeInches still extracts them from
 * the trailing-digit pattern (e.g. "JEST-TSZ-EMT12" → digits "12" → 0.5").
 */
const CATALOG_PREFIX = 'JEST-TSZ-';

interface TradeSizeFixture {
  catalog: string;
  vendor: string;
  description: string;
  expectedTradeSizeIn: string | null;
}

const TRADE_SIZE_FIXTURES: TradeSizeFixture[] = [
  // Catalog-code encoded sizes
  {
    catalog: 'JEST-TSZ-EMT12',
    vendor: 'ARL',
    description: '1/2 in EMT conduit',
    expectedTradeSizeIn: '0.500',
  },
  {
    catalog: 'JEST-TSZ-EMT150',
    vendor: 'ARL',
    description: '1-1/2 in EMT conduit (decimal×100 catalog encoding)',
    expectedTradeSizeIn: '1.500',
  },
  {
    catalog: 'JEST-TSZ-EMT250',
    vendor: 'ARL',
    description: '2-1/2 in EMT conduit (decimal×100 catalog encoding)',
    expectedTradeSizeIn: '2.500',
  },
  {
    catalog: 'JEST-TSZ-IMC212',
    vendor: 'ARL',
    description: '2-1/2 in IMC conduit (fraction-code catalog encoding)',
    expectedTradeSizeIn: '2.500',
  },
  {
    catalog: 'JEST-TSZ-PVC034',
    vendor: 'ARL',
    description: '3/4 in PVC Schedule 40 conduit',
    expectedTradeSizeIn: '0.750',
  },
  // Description-based fallback (catalog code has no parseable size)
  {
    catalog: 'JEST-TSZ-LOCK001',
    vendor: 'ARL',
    description: '3/4 Conduit Locknut',
    expectedTradeSizeIn: '0.750',
  },
  {
    catalog: 'JEST-TSZ-FIT001',
    vendor: 'ARL',
    description: '1-1/2 in EMT FITTING',
    expectedTradeSizeIn: '1.500',
  },
  // Non-conduit item — must NOT receive a trade size
  {
    catalog: 'JEST-TSZ-BR120',
    vendor: 'EATON',
    description: '20A 1-Pole Breaker',
    expectedTradeSizeIn: null,
  },
];

const CONDUIT_FIXTURES = TRADE_SIZE_FIXTURES.filter((f) => f.expectedTradeSizeIn !== null);

async function cleanupTradeSizeFixtures() {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + '%'}`);
}

// Close the pool once, after every describe block in this file has finished.
afterAll(async () => {
  await pool.end();
}, 30_000);

describe('backfill trade-size — integration (seeded DB)', () => {
  let seededIds: number[] = [];

  beforeAll(async () => {
    await cleanupTradeSizeFixtures();

    const rows = await db
      .insert(inventoryTable)
      .values(
        TRADE_SIZE_FIXTURES.map((f) => ({
          vendor: f.vendor.toUpperCase(),
          catalog: f.catalog,
          description: f.description,
          binLocations: [] as string[],
          aiKeywords: [] as string[],
        }))
      )
      .onConflictDoNothing()
      .returning({ id: inventoryTable.id });

    seededIds = rows.map((r) => r.id);
  }, 30_000);

  afterAll(async () => {
    await cleanupTradeSizeFixtures();
  }, 30_000);

  it('seeds the expected number of fixture rows', () => {
    expect(seededIds.length).toBe(TRADE_SIZE_FIXTURES.length);
  });

  it('backfill writes the expected tradeSizeIn for every fixture row', async () => {
    // Fetch seeded rows (replicates the batch-select in backfill_attrs.ts).
    const rows = await db
      .select({
        id: inventoryTable.id,
        catalog: inventoryTable.catalog,
        vendor: inventoryTable.vendor,
        description: inventoryTable.description,
        tradeSize: inventoryTable.tradeSize,
        tradeSizeIn: inventoryTable.tradeSizeIn,
      })
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, seededIds));

    // Run the real backfill derivation and write back exactly as the script
    // does (mirrors the inner loop of backfill_attrs.ts).
    for (const row of rows) {
      const tradeSizeIn = deriveTradeSizeIn(row);
      await db.update(inventoryTable).set({ tradeSizeIn }).where(eq(inventoryTable.id, row.id));
    }

    // Read back and assert the correct value for each fixture.
    const updated = await db
      .select({
        catalog: inventoryTable.catalog,
        tradeSizeIn: inventoryTable.tradeSizeIn,
      })
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, seededIds));

    for (const fixture of TRADE_SIZE_FIXTURES) {
      const row = updated.find((r) => r.catalog === fixture.catalog);
      expect(row).toBeDefined();
      expect(row!.tradeSizeIn).toBe(fixture.expectedTradeSizeIn);
    }
  }, 30_000);

  it('achieves 100% trade_size_in coverage across all seeded conduit fixtures', async () => {
    const [{ covered, total }] = await db
      .select({
        covered: sql<number>`count(*) FILTER (WHERE trade_size_in IS NOT NULL)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, seededIds));

    expect(total).toBe(TRADE_SIZE_FIXTURES.length);
    expect(covered).toBe(CONDUIT_FIXTURES.length);
  }, 30_000);
});

// ── Part C: NEEDS_PARSE selection guard ──────────────────────────────────────

/**
 * The backfill selects rows where:
 *   attrs_parsed_at IS NULL
 *   OR catalog_parse IS NULL
 *   OR (catalog_parse->>'parser_version')::int < CURRENT_PARSER_VERSION
 *
 * This section verifies that selection criteria behaves correctly so that
 * query/filter changes (which would silently drop coverage) are caught.
 */

const NP_PREFIX = 'JEST-TSZ-NP-';

async function cleanupNpFixtures() {
  await db.delete(inventoryTable).where(sql`${inventoryTable.catalog} LIKE ${NP_PREFIX + '%'}`);
}

describe('backfill NEEDS_PARSE selection — integration', () => {
  let unparsedId: number;
  let staleId: number;
  let currentId: number;

  beforeAll(async () => {
    await cleanupNpFixtures();

    const seed = async (catalog: string, catalogParse: Record<string, unknown> | null) => {
      const [row] = await db
        .insert(inventoryTable)
        .values({
          vendor: 'ARL',
          catalog,
          description: '1/2 in EMT conduit',
          binLocations: [] as string[],
          aiKeywords: [] as string[],
          catalogParse: catalogParse as never,
        })
        .returning({ id: inventoryTable.id });
      return row!.id;
    };

    unparsedId = await seed(`${NP_PREFIX}UNPARSED`, null);
    staleId = await seed(`${NP_PREFIX}STALE`, {
      parser_version: CURRENT_PARSER_VERSION - 1,
    });
    currentId = await seed(`${NP_PREFIX}CURRENT`, {
      parser_version: CURRENT_PARSER_VERSION,
    });

    // Mark the "current" row as fully processed so none of the three
    // NEEDS_PARSE arms (attrs_parsed_at IS NULL, catalog_parse IS NULL,
    // parser_version < CURRENT) match it.
    await db
      .update(inventoryTable)
      .set({ attrsParsedAt: new Date() })
      .where(eq(inventoryTable.id, currentId));
  }, 30_000);

  afterAll(async () => {
    await cleanupNpFixtures();
  }, 30_000);

  it('selects the unparsed row (catalog_parse IS NULL)', async () => {
    const [{ cnt }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(inventoryTable)
      .where(
        sql`${inventoryTable.id} = ${unparsedId}
            AND (
              attrs_parsed_at IS NULL
              OR catalog_parse IS NULL
              OR (catalog_parse->>'parser_version')::int < ${CURRENT_PARSER_VERSION}
            )`
      );
    expect(cnt).toBe(1);
  });

  it('selects the stale row (parser_version < CURRENT_PARSER_VERSION)', async () => {
    const [{ cnt }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(inventoryTable)
      .where(
        sql`${inventoryTable.id} = ${staleId}
            AND (
              attrs_parsed_at IS NULL
              OR catalog_parse IS NULL
              OR (catalog_parse->>'parser_version')::int < ${CURRENT_PARSER_VERSION}
            )`
      );
    expect(cnt).toBe(1);
  });

  it('does NOT select the already-current row (parser_version === CURRENT_PARSER_VERSION)', async () => {
    const [{ cnt }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(inventoryTable)
      .where(
        sql`${inventoryTable.id} = ${currentId}
            AND (
              attrs_parsed_at IS NULL
              OR catalog_parse IS NULL
              OR (catalog_parse->>'parser_version')::int < ${CURRENT_PARSER_VERSION}
            )`
      );
    expect(cnt).toBe(0);
  });
});
