/**
 * Regression guard: trade-size coverage in the attribute backfill pipeline.
 *
 * The coverage once silently dropped from 1,377 → 760 items because a change
 * to the parsing logic caused catalog codes that had previously resolved to a
 * trade size to no longer do so.  These tests catch that class of regression
 * by:
 *
 *  Part A — Computation unit tests (no DB):
 *    Directly tests the per-item trade-size computation replicating the exact
 *    decision tree in backfill_attrs.ts for a set of catalog codes that MUST
 *    always produce a non-null trade_size_in.
 *
 *  Part B — Integration tests (live DB):
 *    Seeds known fixture rows, runs the backfill computation on each, writes
 *    the results to the DB, then reads back and asserts:
 *      (a) each conduit item got the expected trade_size_in value, and
 *      (b) coverage across the seeded conduit items is 100 %.
 */

import { db, pool, inventoryTable } from '@workspace/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { parseTradeSizeInches, isConduitOrPipe } from '../src/utils/tradeSize';
import { parseTradeSize } from '../src/enrichment/parseAttributes';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Replicates the per-item trade-size derivation from backfill_attrs.ts.
 * Kept in sync with the script so this test can detect drift.
 */
function computeTradeSizeIn(item: {
  catalog: string | null;
  vendor: string | null;
  description: string | null;
  tradeSize?: string | null;
  tradeSizeIn?: string | null;
}): string | null {
  const hasTradeSizeText = item.tradeSize != null && item.tradeSize.trim() !== '';
  const isConduit =
    isConduitOrPipe(item.catalog, item.vendor, item.description) || hasTradeSizeText;

  const rawCatalogSize = isConduit ? parseTradeSizeInches(item.catalog) : null;
  const tradeSizeInches = isConduit
    ? rawCatalogSize !== null && rawCatalogSize <= 12
      ? rawCatalogSize
      : (parseTradeSizeInches(item.description) ??
        parseTradeSize(item.description) ??
        parseTradeSize(item.catalog) ??
        parseTradeSize(item.tradeSize))
    : null;

  const computedTradeSizeIn =
    tradeSizeInches !== null && tradeSizeInches <= 12 ? tradeSizeInches.toFixed(3) : null;

  // Idempotency: preserve a previously-correct value if the current derivation
  // produces null (mirrors the backfill script's behaviour).
  return computedTradeSizeIn ?? item.tradeSizeIn ?? null;
}

// ── Part A: computation unit tests (no DB required) ──────────────────────────

describe('backfill trade-size computation — catalog-code cases', () => {
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
    const result = computeTradeSizeIn({
      catalog,
      vendor: null,
      description: catalog + ' conduit',
    });
    expect(result).toBe(expected);
  });
});

describe('backfill trade-size computation — description fallback cases', () => {
  it('LOCKNUT with 3/4" in description → 0.750"', () => {
    const result = computeTradeSizeIn({
      catalog: 'LN001',
      vendor: null,
      description: '3/4 Conduit Locknut',
    });
    expect(result).toBe('0.750');
  });

  it('generic conduit item with "1-1/2 in" in description → 1.500"', () => {
    const result = computeTradeSizeIn({
      catalog: 'CONDFIT99',
      vendor: null,
      description: '1-1/2 in Conduit Connector',
    });
    expect(result).toBe('1.500');
  });

  it('FITTING with 1/2" in description → 0.500"', () => {
    const result = computeTradeSizeIn({
      catalog: 'FIT001',
      vendor: null,
      description: '1/2" EMT FITTING',
    });
    expect(result).toBe('0.500');
  });
});

describe('backfill trade-size computation — non-conduit items', () => {
  it.each([
    ['BR120', '20A Breaker', 'circuit breaker → no trade size'],
    ['HBL5262I', '20A 125V Duplex Receptacle', 'receptacle → no trade size'],
    ['NM214', 'Romex 14/2 wire', 'wire → no trade size'],
  ])('catalog=%s desc=%s → null (%s)', (catalog, description, _note) => {
    const result = computeTradeSizeIn({ catalog, vendor: null, description });
    expect(result).toBeNull();
  });
});

describe('backfill trade-size computation — idempotency', () => {
  it('preserves a previously-correct tradeSizeIn when the current derivation returns null', () => {
    const result = computeTradeSizeIn({
      catalog: 'CONDFIT99',
      vendor: null,
      description: 'Conduit reducer body no size hint',
      tradeSizeIn: '0.750',
    });
    expect(result).toBe('0.750');
  });
});

// ── Part B: integration tests (live PostgreSQL DB) ────────────────────────────

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

/** Clean up all test rows. */
async function cleanupTradeSizeFixtures() {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + '%'}`);
}

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
    await pool.end();
  }, 30_000);

  it('seeds the expected number of fixture rows', () => {
    expect(seededIds.length).toBe(TRADE_SIZE_FIXTURES.length);
  });

  it('backfill computation produces the expected tradeSizeIn for every fixture row', async () => {
    // Fetch the seeded rows (replicating the batch-select in backfill_attrs.ts).
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

    // Run the backfill computation and write back (mirrors backfill_attrs.ts).
    for (const row of rows) {
      const tradeSizeIn = computeTradeSizeIn(row);
      await db.update(inventoryTable).set({ tradeSizeIn }).where(eq(inventoryTable.id, row.id));
    }

    // Read back and assert each item got the correct value.
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

    const conduitCount = CONDUIT_FIXTURES.length;
    expect(total).toBe(TRADE_SIZE_FIXTURES.length);

    // Every seeded conduit item must have a non-null trade_size_in.
    expect(covered).toBe(conduitCount);
  }, 30_000);
});
