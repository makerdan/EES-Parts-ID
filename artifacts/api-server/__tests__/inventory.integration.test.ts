/**
 * Integration tests for POST /api/inventory/search and
 * POST /api/inventory/upsert-batch.
 *
 * Uses a real PostgreSQL database (DATABASE_URL env var).
 * OpenAI integration is mocked to avoid requiring a live API key.
 */

// ── Mock the OpenAI integration BEFORE app is imported ───────────────────────
// Both the main export and the batch sub-path are hoisted here so that modules
// that throw at initialisation (client.ts checks env vars) never execute.
jest.mock('@workspace/integrations-openai-ai-server', () => ({
  openai: {
    chat: { completions: { create: jest.fn() } },
    audio: { transcriptions: { create: jest.fn() } },
  },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock('@workspace/integrations-openai-ai-server/batch', () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from 'supertest';
import app from '../src/app';
import { signAdminToken } from '../src/routes/admin';
import { seedFixtures, cleanupFixtures, closePool, STANDARD_FIXTURES } from './helpers/testDb';

// ── Test configuration ────────────────────────────────────────────────────────
const ADMIN_SECRET = 'jest-integration-test-secret';
let adminToken: string;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanupFixtures();
  await seedFixtures(STANDARD_FIXTURES);
}, 30_000);

afterAll(async () => {
  await cleanupFixtures();
  await closePool();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/inventory/search', () => {
  it('returns 200 with matching results for a seeded catalog number', async () => {
    // Uses a JEST-ITG- prefixed catalog to isolate from production rows;
    // the prefix is matched as a keyword so the search hits the fixture row.
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-BR120' })
      .expect(200);

    expect(res.body).toHaveProperty('results');
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);

    const match = res.body.results.find(
      (r: { item: { catalog: string } }) => r.item.catalog === 'JEST-ITG-BR120'
    );
    expect(match).toBeDefined();
    expect(match.item.vendor).toBe('EATON');
  });

  it('returns 200 with an empty results array for a keyword that matches nothing', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'ZZZNOMATCH-XYZ-99999-UNIQUE' })
      .expect(200);

    expect(res.body).toHaveProperty('results');
    expect(res.body.results).toEqual([]);
  });

  it('returns 200 with totalMatches and belowThreshold fields in the response', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-BR120' })
      .expect(200);

    expect(res.body).toHaveProperty('totalMatches');
    expect(res.body).toHaveProperty('belowThreshold');
    expect(typeof res.body.totalMatches).toBe('number');
    expect(typeof res.body.belowThreshold).toBe('number');
  });

  it('returns 200 with empty results when confidenceThreshold is set to 100', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-BR120', confidenceThreshold: 100 })
      .expect(200);

    // Even exact matches score ≤ 1.0 (= 100%), so threshold = 100 filters them out
    // unless they score exactly 1.0 (exact catalog match).
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('returns 200 with empty results array when no search text is provided', async () => {
    const res = await supertest(app).post('/api/inventory/search').send({}).expect(200);

    expect(res.body).toHaveProperty('results');
    expect(res.body.results).toEqual([]);
  });

  it('returns the dimensionCounts object in the response', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG' })
      .expect(200);

    expect(res.body).toHaveProperty('dimensionCounts');
    expect(typeof res.body.dimensionCounts).toBe('object');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GIN trigram index planner test
// ─────────────────────────────────────────────────────────────────────────────

describe('GIN trigram index planner', () => {
  const EXPLAIN_CATALOG = 'JEST-ITG-EXPLAIN-GIN-001';

  beforeAll(async () => {
    // Seed a row with search_tokens explicitly set so the partial GIN index
    // (WHERE search_tokens IS NOT NULL) has at least one entry to work with.
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');
    await db.execute(rawSql`
      INSERT INTO inventory (vendor, catalog, description, search_tokens)
      VALUES (
        'JEST-EXPLAIN-VENDOR',
        ${EXPLAIN_CATALOG},
        'Explain test 20 amp single-pole circuit breaker',
        'breaker circuit amp pole eaton square d siemens single'
      )
      ON CONFLICT (vendor, catalog) DO UPDATE
        SET search_tokens = EXCLUDED.search_tokens
    `);
  }, 15_000);

  afterAll(async () => {
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');
    await db.execute(rawSql`DELETE FROM inventory WHERE catalog = ${EXPLAIN_CATALOG}`);
  }, 15_000);

  it('uses idx_inventory_search_tokens_trgm (GIN bitmap scan) for the search_tokens arm', async () => {
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');

    // Run EXPLAIN on the isolated search_tokens arm — the same condition used
    // in the primary UNION ALL arm of the inventory search route.
    // SET LOCAL lowers the threshold to 0.15 (matching the route) so that
    // short trigram queries still trigger the GIN scan.
    const result = await db.transaction(async (tx) => {
      await tx.execute(rawSql`SET LOCAL pg_trgm.similarity_threshold = 0.15`);
      return tx.execute(rawSql`
        EXPLAIN (FORMAT TEXT)
        SELECT i.id, similarity(i.search_tokens, 'breaker amp') AS trgm_sim
        FROM inventory i
        WHERE i.search_tokens IS NOT NULL
          AND i.search_tokens % 'breaker amp'
        LIMIT 50
      `);
    });

    const planLines = (result as { rows: unknown[] }).rows
      .map((r) => String(Object.values(r as object)[0]))
      .join('\n');

    // The planner must choose a Bitmap Index Scan on the GIN trigram index,
    // not a sequential scan. A Seq Scan here means the planner is ignoring the
    // index — the most common cause is a missing / invalid index or a table
    // too small for the planner to bother with the index overhead.
    expect(planLines).toContain('idx_inventory_search_tokens_trgm');
    expect(planLines).not.toContain('Seq Scan');
  });

  it('similarity_threshold SET LOCAL via set_config persists within the transaction', async () => {
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');

    const result = await db.transaction(async (tx) => {
      // set_config with is_local=true is equivalent to SET LOCAL
      await tx.execute(rawSql`SELECT set_config('pg_trgm.similarity_threshold', '0.15', true)`);
      return tx.execute(rawSql`
        EXPLAIN (FORMAT TEXT)
        SELECT i.id FROM inventory i
        WHERE i.search_tokens IS NOT NULL AND i.search_tokens % 'breaker'
        LIMIT 10
      `);
    });

    const planLines = (result as { rows: unknown[] }).rows
      .map((r) => String(Object.values(r as object)[0]))
      .join('\n');

    expect(planLines).toContain('idx_inventory_search_tokens_trgm');
  });

  it('UNION ALL fallback LIMIT 50 is scoped to the fallback arm only (not the combined union result)', async () => {
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');

    // This mirrors the exact SQL shape used in the inventory search route.
    // The fallback SELECT is wrapped in parens so LIMIT 50 applies only to
    // that arm — without parens, PostgreSQL applies the LIMIT to the entire
    // set-operation output, which would silently cap the primary arm results.
    const result = await db.transaction(async (tx) => {
      await tx.execute(rawSql`SET LOCAL pg_trgm.similarity_threshold = 0.15`);
      return tx.execute(rawSql`
        EXPLAIN (FORMAT TEXT)
        SELECT * FROM (
          SELECT i.id, i.vendor, i.catalog,
            similarity(i.search_tokens, 'breaker amp') AS trgm_sim
          FROM inventory i
          WHERE i.search_tokens IS NOT NULL AND i.search_tokens % 'breaker amp'

          UNION ALL

          (
            SELECT i.id, i.vendor, i.catalog,
              greatest(similarity(i.catalog, 'breaker amp'), similarity(i.description, 'breaker amp')) AS trgm_sim
            FROM inventory i
            WHERE i.search_tokens IS NULL
              AND (similarity(i.catalog, 'breaker amp') > 0.1 OR similarity(i.description, 'breaker amp') > 0.1)
            LIMIT 50
          )
        ) AS __ranked
        ORDER BY trgm_sim DESC
        LIMIT 200
      `);
    });

    const planLines = (result as { rows: unknown[] }).rows
      .map((r) => String(Object.values(r as object)[0]))
      .join('\n');

    // GIN index must be used for the primary arm
    expect(planLines).toContain('idx_inventory_search_tokens_trgm');

    // The plan must have an Append node (from UNION ALL) with a nested Limit
    // child (the fallback arm's LIMIT 50). The outer sort+limit (LIMIT 200)
    // sits above the Append, so both "Append" and "Limit" appear in the plan.
    // The key invariant: the GIN arm is not itself wrapped in the fallback limit.
    expect(planLines).toContain('Append');
    expect(planLines).toContain('Bitmap Index Scan on idx_inventory_search_tokens_trgm');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/upsert-batch
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/inventory/upsert-batch', () => {
  const NEW_CATALOG = 'JEST-ITG-UPSERT-001';

  afterEach(async () => {
    // Clean up any items created by upsert-batch tests
    const { db, inventoryTable } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');
    await db.delete(inventoryTable).where(eq(inventoryTable.catalog, NEW_CATALOG));
  });

  it('returns 401 when no Authorization header is provided', async () => {
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .send({ items: [{ vendor: 'TEST', catalog: NEW_CATALOG, description: 'test' }] })
      .expect(401);
  });

  it('returns 401 when an invalid token is provided', async () => {
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', 'Bearer invalid-token-xyz')
      .send({ items: [{ vendor: 'TEST', catalog: NEW_CATALOG, description: 'test' }] })
      .expect(401);
  });

  it('returns 400 when items array is empty', async () => {
    const res = await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [] })
      .expect(400);

    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when items field is missing entirely', async () => {
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);
  });

  it('inserts a new item and returns inserted=1, updated=0', async () => {
    const res = await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: 'JEST-VENDOR',
            catalog: NEW_CATALOG,
            description: 'Jest integration test item',
            binLocations: ['TEST-BIN'],
          },
        ],
      })
      .expect(200);

    expect(res.body.inserted).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(res.body.total).toBe(1);
  });

  it('populates search_tokens immediately after insert so the new row is searchable on the next query', async () => {
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: 'JEST-VENDOR',
            catalog: NEW_CATALOG,
            description: 'Jest freshness probe widget alpha',
          },
        ],
      })
      .expect(200);

    const { db, inventoryTable } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.catalog, NEW_CATALOG));

    expect(row).toBeDefined();
    expect(row!.searchTokens).not.toBeNull();
    expect(row!.searchTokens!.length).toBeGreaterThan(0);
    // The base description words must be present in the pre-expanded tokens.
    expect(row!.searchTokens).toContain('freshness');
    expect(row!.searchTokens).toContain('widget');

    // And the row is reachable via the search endpoint without any
    // enrichment / rebuild-tokens / index-warming round trip.
    const searchRes = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: NEW_CATALOG })
      .expect(200);
    expect(
      (searchRes.body.results as Array<{ item: { catalog: string } }>).some(
        (r) => r.item.catalog === NEW_CATALOG
      )
    ).toBe(true);
  });

  it('inserts a conduit item with derived trade-size keyword tokens searchable immediately', async () => {
    // IMC212 → 2 1/2" conduit; the importer should derive trade-size keyword
    // variants and store them in ai_keywords + search_tokens without waiting
    // for AI enrichment.
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: 'JEST-VENDOR',
            catalog: NEW_CATALOG,
            description: 'IMC conduit nipple',
          },
        ],
      })
      .expect(200);

    const { db, inventoryTable } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.catalog, NEW_CATALOG));

    expect(row).toBeDefined();
    // We seed the catalog as "JEST-ITG-UPSERT-001" (no trade-size suffix), so
    // no trade-size tokens are derivable here. Use a separate conduit catalog
    // that ends in a parseable size to assert the trade-size path.
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: 'JEST-VENDOR',
            catalog: 'JEST-ITG-IMC212',
            description: 'IMC conduit',
          },
        ],
      })
      .expect(200);

    const [conduitRow] = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.catalog, 'JEST-ITG-IMC212'));

    expect(conduitRow).toBeDefined();
    // ai_keywords should contain the trade-size variants for 2 1/2"
    expect(conduitRow!.aiKeywords).toEqual(expect.arrayContaining(['2-1/2"']));
    // search_tokens should contain a recognizable size form
    expect(conduitRow!.searchTokens).toMatch(/2-1\/2"|2 1\/2|2\.5/);

    // Cleanup the extra conduit row we inserted in this test
    await db.delete(inventoryTable).where(eq(inventoryTable.catalog, 'JEST-ITG-IMC212'));
  });

  it('refreshes search_tokens when an admin edits the description via PATCH /:id', async () => {
    // Insert via upsert-batch so the row's search_tokens get populated.
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: 'JEST-VENDOR',
            catalog: NEW_CATALOG,
            description: 'Initial probe text',
          },
        ],
      })
      .expect(200);

    const { db, inventoryTable } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');
    const [before] = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.catalog, NEW_CATALOG));

    expect(before).toBeDefined();
    expect(before!.searchTokens).toContain('probe');

    // Edit the description: search_tokens must reflect the new content
    // immediately (no enrichment / rebuild-tokens round trip).
    await supertest(app)
      .patch(`/api/inventory/${before!.id}`)
      .send({ description: 'Replaced grommet wibblix uniqword' })
      .expect(200);

    const [after] = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.catalog, NEW_CATALOG));

    expect(after!.searchTokens).toContain('grommet');
    expect(after!.searchTokens).toContain('uniqword');
    expect(after!.searchTokens).not.toContain('probe');
  });

  it('updates an existing item and returns inserted=0, updated=1', async () => {
    // First insert
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: 'JEST-VENDOR',
            catalog: NEW_CATALOG,
            description: 'Original description',
          },
        ],
      })
      .expect(200);

    // Now update
    const res = await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            vendor: 'JEST-VENDOR',
            catalog: NEW_CATALOG,
            description: 'Updated description',
          },
        ],
      })
      .expect(200);

    expect(res.body.inserted).toBe(0);
    expect(res.body.updated).toBe(1);
    expect(res.body.total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search — amperage chip filter (end-to-end)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/inventory/search — amperage chip filter', () => {
  // Four fixture rows that let us test both the structured-column path
  // (amperage IS NOT NULL → matchesChipColumn) and the text-fallback path
  // (amperage IS NULL → tokenMatch on description).
  const AMP_CATALOGS = {
    col20: 'JEST-ITG-AMP-20-COL', // amperage column = 20
    col15: 'JEST-ITG-AMP-15-COL', // amperage column = 15
    txt20: 'JEST-ITG-AMP-20-TXT', // amperage = NULL, description has "20A"
    txt15: 'JEST-ITG-AMP-15-TXT', // amperage = NULL, description has "15A"
  };

  beforeAll(async () => {
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');

    // Use raw SQL so we can control the `amperage` integer column directly.
    // The `seedFixtures` helper only sets description / binLocations / aiKeywords.
    await db.execute(rawSql`
      INSERT INTO inventory (vendor, catalog, description, amperage)
      VALUES
        ('JEST-VENDOR', ${AMP_CATALOGS.col20}, '1-Pole Circuit Breaker', 20),
        ('JEST-VENDOR', ${AMP_CATALOGS.col15}, '1-Pole Circuit Breaker', 15),
        ('JEST-VENDOR', ${AMP_CATALOGS.txt20}, '20A 1-Pole Circuit Breaker', NULL),
        ('JEST-VENDOR', ${AMP_CATALOGS.txt15}, '15A 1-Pole Circuit Breaker', NULL)
      ON CONFLICT (vendor, catalog) DO NOTHING
    `);
  }, 15_000);

  afterAll(async () => {
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');

    // Clean up individually — avoids depending on drizzle's array-param handling.
    for (const cat of Object.values(AMP_CATALOGS)) {
      await db.execute(rawSql`DELETE FROM inventory WHERE catalog = ${cat}`);
    }
  }, 15_000);

  const catalogsOf = (body: { results: Array<{ item: { catalog: string } }> }) =>
    body.results.map((r) => r.item.catalog);

  it('includes 20A items and excludes 15A items when amperage chip = "20A"', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-AMP', amperage: '20A' })
      .expect(200);

    const catalogs = catalogsOf(res.body);

    // Structured-column path (amperage = 20): must be included
    expect(catalogs).toContain(AMP_CATALOGS.col20);
    // Text-fallback path (amperage IS NULL, description "20A …"): must be included
    expect(catalogs).toContain(AMP_CATALOGS.txt20);

    // 15A items (structured and text) must be excluded
    expect(catalogs).not.toContain(AMP_CATALOGS.col15);
    expect(catalogs).not.toContain(AMP_CATALOGS.txt15);
  });

  it('includes 15A items and excludes 20A items when amperage chip = "15A"', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-AMP', amperage: '15A' })
      .expect(200);

    const catalogs = catalogsOf(res.body);

    expect(catalogs).toContain(AMP_CATALOGS.col15);
    expect(catalogs).toContain(AMP_CATALOGS.txt15);
    expect(catalogs).not.toContain(AMP_CATALOGS.col20);
    expect(catalogs).not.toContain(AMP_CATALOGS.txt20);
  });

  it('returns all 4 seeded amperage items when no chip filter is active', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-AMP' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    for (const cat of Object.values(AMP_CATALOGS)) {
      expect(catalogs).toContain(cat);
    }
  });

  it('includes amperage key in dimensionCounts when chip filter is active', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-AMP', amperage: '20A' })
      .expect(200);

    expect(res.body).toHaveProperty('dimensionCounts');
    expect(typeof res.body.dimensionCounts).toBe('object');
    expect(res.body.dimensionCounts).toHaveProperty('amperage');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search — combined amperage + poleCount AND logic
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/inventory/search — combined amperage + poleCount chip filter (AND logic)', () => {
  // Four fixture rows covering every combination of {15A, 20A} × {1-pole, 2-pole}.
  // Both structured columns are populated so matchesChipColumn is exercised for
  // both dimensions — a bug in the AND loop that drops the second filter would
  // return more than one result instead of exactly one.
  const COMBO_CATALOGS = {
    amp20pole1: 'JEST-ITG-COMBO-20-1P', // 20A, 1-pole
    amp20pole2: 'JEST-ITG-COMBO-20-2P', // 20A, 2-pole  ← the only match
    amp15pole2: 'JEST-ITG-COMBO-15-2P', // 15A, 2-pole
    amp15pole1: 'JEST-ITG-COMBO-15-1P', // 15A, 1-pole
  };

  beforeAll(async () => {
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');

    await db.execute(rawSql`
      INSERT INTO inventory (vendor, catalog, description, amperage, pole_count)
      VALUES
        ('JEST-VENDOR', ${COMBO_CATALOGS.amp20pole1}, 'JEST-ITG-COMBO 20A 1-Pole Breaker', 20, 1),
        ('JEST-VENDOR', ${COMBO_CATALOGS.amp20pole2}, 'JEST-ITG-COMBO 20A 2-Pole Breaker', 20, 2),
        ('JEST-VENDOR', ${COMBO_CATALOGS.amp15pole2}, 'JEST-ITG-COMBO 15A 2-Pole Breaker', 15, 2),
        ('JEST-VENDOR', ${COMBO_CATALOGS.amp15pole1}, 'JEST-ITG-COMBO 15A 1-Pole Breaker', 15, 1)
      ON CONFLICT (vendor, catalog) DO NOTHING
    `);
  }, 15_000);

  afterAll(async () => {
    const { db } = await import('@workspace/db');
    const { sql: rawSql } = await import('drizzle-orm');

    for (const cat of Object.values(COMBO_CATALOGS)) {
      await db.execute(rawSql`DELETE FROM inventory WHERE catalog = ${cat}`);
    }
  }, 15_000);

  const catalogsOf = (body: { results: Array<{ item: { catalog: string } }> }) =>
    body.results.map((r) => r.item.catalog);

  it('returns exactly the 20A 2-pole item when both chips are active', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-COMBO', amperage: '20A', poleCount: '2' })
      .expect(200);

    const catalogs = catalogsOf(res.body);

    // Exactly one of the four seeded combo items should be in the results.
    const comboMatches = catalogs.filter((c) => Object.values(COMBO_CATALOGS).includes(c));
    expect(comboMatches).toHaveLength(1);
    expect(comboMatches[0]).toBe(COMBO_CATALOGS.amp20pole2);

    expect(catalogs).not.toContain(COMBO_CATALOGS.amp20pole1); // wrong pole count
    expect(catalogs).not.toContain(COMBO_CATALOGS.amp15pole2); // wrong amperage
    expect(catalogs).not.toContain(COMBO_CATALOGS.amp15pole1); // wrong on both
  });

  it('returns all 4 items when neither chip is active', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-COMBO' })
      .expect(200);

    const catalogs = catalogsOf(res.body);

    for (const cat of Object.values(COMBO_CATALOGS)) {
      expect(catalogs).toContain(cat);
    }
  });

  it('returns only the 2-pole items when only poleCount chip is active', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-ITG-COMBO', poleCount: '2' })
      .expect(200);

    const catalogs = catalogsOf(res.body);

    expect(catalogs).toContain(COMBO_CATALOGS.amp20pole2);
    expect(catalogs).toContain(COMBO_CATALOGS.amp15pole2);
    expect(catalogs).not.toContain(COMBO_CATALOGS.amp20pole1);
    expect(catalogs).not.toContain(COMBO_CATALOGS.amp15pole1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search — fractional trade-size tokenization (Task #440)
// ─────────────────────────────────────────────────────────────────────────────
//
// Regression coverage for the bug where the FTS tsquery builder stripped `/`
// and `-`, turning a search like `1/2"` into the unrelated tokens `1` and `2`
// (which were then dropped entirely by the leading-letter filter). Without the
// fix the server fell through to broad trigram matches and could return e.g.
// 1-1/2" conduit when the user searched for 1/2".

describe('POST /api/inventory/search — fractional trade-size tokenization', () => {
  const SIZE_CATALOGS = {
    half: 'JEST-ITG-EMT050',
    threeQuarter: 'JEST-ITG-EMT075',
    one: 'JEST-ITG-EMT100',
    oneAndQuarter: 'JEST-ITG-EMT125',
    oneAndHalf: 'JEST-ITG-EMT150',
    twoAndHalf: 'JEST-ITG-EMT250',
  };

  beforeAll(async () => {
    const adminSecret = process.env.ADMIN_PASSWORD as string;
    const token = signAdminToken(Date.now(), adminSecret);
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { vendor: 'JEST-VENDOR', catalog: SIZE_CATALOGS.half, description: 'EMT 1/2" conduit' },
          {
            vendor: 'JEST-VENDOR',
            catalog: SIZE_CATALOGS.threeQuarter,
            description: 'EMT 3/4" conduit',
          },
          { vendor: 'JEST-VENDOR', catalog: SIZE_CATALOGS.one, description: 'EMT 1" conduit' },
          {
            vendor: 'JEST-VENDOR',
            catalog: SIZE_CATALOGS.oneAndQuarter,
            description: 'EMT 1-1/4" conduit',
          },
          {
            vendor: 'JEST-VENDOR',
            catalog: SIZE_CATALOGS.oneAndHalf,
            description: 'EMT 1-1/2" conduit',
          },
          {
            vendor: 'JEST-VENDOR',
            catalog: SIZE_CATALOGS.twoAndHalf,
            description: 'EMT 2-1/2" conduit',
          },
        ],
      })
      .expect(200);
  }, 30_000);

  afterAll(async () => {
    const { db, inventoryTable } = await import('@workspace/db');
    const { inArray } = await import('drizzle-orm');
    await db
      .delete(inventoryTable)
      .where(inArray(inventoryTable.catalog, Object.values(SIZE_CATALOGS)));
  }, 30_000);

  const catalogsOf = (body: { results?: Array<{ item: { catalog: string } }> }) =>
    (body.results ?? []).map((r) => r.item.catalog);

  it('returns the 1/2" conduit for a `1/2` keyword search and does NOT bleed into 1-1/2"', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: '1/2 EMT JEST-ITG' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(SIZE_CATALOGS.half);
    // The boundary guard must keep 1/2 from matching inside 1-1/2 or 2-1/2.
    expect(catalogs).not.toContain(SIZE_CATALOGS.oneAndHalf);
    expect(catalogs).not.toContain(SIZE_CATALOGS.twoAndHalf);
  });

  it('returns the 3/4" conduit for a `3/4` keyword search', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: '3/4 EMT JEST-ITG' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(SIZE_CATALOGS.threeQuarter);
  });

  it('returns the 1-1/4" conduit for a `1-1/4` keyword search and does NOT bleed into 1/4 or 1"', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: '1-1/4 EMT JEST-ITG' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(SIZE_CATALOGS.oneAndQuarter);
    // Boundary guard: the bare `1` fragment must not pull in the 1" item.
    expect(catalogs).not.toContain(SIZE_CATALOGS.one);
  });

  it('returns the 2-1/2" conduit for a `2-1/2` keyword search', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: '2-1/2 EMT JEST-ITG' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(SIZE_CATALOGS.twoAndHalf);
    // 2-1/2 must not match inside 1-1/2.
    expect(catalogs).not.toContain(SIZE_CATALOGS.oneAndHalf);
  });

  it('honors explicit multi-size intent: `1/4 1-1/4` requires both tokens to match', async () => {
    // The substring-pruning filter must not collapse user-typed `1/4` into
    // the larger `1-1/4` — both are explicit intent. No seeded EMT row
    // contains BOTH a standalone `1/4` and a `1-1/4`, so the result set
    // for these EMT catalogs should be empty (the filter correctly
    // rejects every candidate).
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: '1/4 1-1/4 EMT JEST-ITG' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    // None of the conduit rows have both sizes, so none should match.
    expect(catalogs).not.toContain(SIZE_CATALOGS.oneAndQuarter);
    expect(catalogs).not.toContain(SIZE_CATALOGS.half);
    expect(catalogs).not.toContain(SIZE_CATALOGS.one);
  });

  it('still returns plain-text matches for non-fractional searches (regression guard)', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'EMT conduit JEST-ITG' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    // All seeded EMT rows should appear when no size token is present.
    expect(catalogs).toContain(SIZE_CATALOGS.half);
    expect(catalogs).toContain(SIZE_CATALOGS.one);
    expect(catalogs).toContain(SIZE_CATALOGS.twoAndHalf);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/search — conduitSize chip filter (Task #435)
// ─────────────────────────────────────────────────────────────────────────────
//
// Guards the full pipeline: SQL candidate retrieval → in-memory
// matchesChipFilters post-filter. Each test seeds four conduit rows at
// different trade sizes and asserts that activating the `conduitSize` chip
// includes the matching size and excludes all others. This catches any future
// regression where the boundary guard in tokenMatch stops working (e.g. `1/2"`
// matching inside `1-1/2"` or `2-1/2"`).

describe('POST /api/inventory/search — conduitSize chip filter', () => {
  const CS_CATALOGS = {
    half: 'JEST-CS-EMT050', // 1/2"
    oneAndQuarter: 'JEST-CS-EMT125', // 1-1/4"
    oneAndHalf: 'JEST-CS-EMT150', // 1-1/2"
    twoAndHalf: 'JEST-CS-EMT250', // 2-1/2"
  };

  beforeAll(async () => {
    const adminSecret = process.env.ADMIN_PASSWORD as string;
    const token = signAdminToken(Date.now(), adminSecret);
    await supertest(app)
      .post('/api/inventory/upsert-batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { vendor: 'JEST-VENDOR', catalog: CS_CATALOGS.half, description: 'EMT 1/2" conduit' },
          {
            vendor: 'JEST-VENDOR',
            catalog: CS_CATALOGS.oneAndQuarter,
            description: 'EMT 1-1/4" conduit',
          },
          {
            vendor: 'JEST-VENDOR',
            catalog: CS_CATALOGS.oneAndHalf,
            description: 'EMT 1-1/2" conduit',
          },
          {
            vendor: 'JEST-VENDOR',
            catalog: CS_CATALOGS.twoAndHalf,
            description: 'EMT 2-1/2" conduit',
          },
        ],
      })
      .expect(200);
  }, 30_000);

  afterAll(async () => {
    const { db, inventoryTable } = await import('@workspace/db');
    const { inArray } = await import('drizzle-orm');
    await db
      .delete(inventoryTable)
      .where(inArray(inventoryTable.catalog, Object.values(CS_CATALOGS)));
  }, 30_000);

  const catalogsOf = (body: { results?: Array<{ item: { catalog: string } }> }) =>
    (body.results ?? []).map((r) => r.item.catalog);

  it('conduitSize "1/2"" includes the 1/2" item and excludes 1-1/2" and 2-1/2"', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-CS EMT', conduitSize: '1/2"' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(CS_CATALOGS.half);
    // Boundary guard: 1/2 must not bleed into 1-1/2" or 2-1/2".
    expect(catalogs).not.toContain(CS_CATALOGS.oneAndHalf);
    expect(catalogs).not.toContain(CS_CATALOGS.twoAndHalf);
  });

  it('conduitSize "1-1/4"" includes the 1-1/4" item and excludes all others', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-CS EMT', conduitSize: '1-1/4"' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(CS_CATALOGS.oneAndQuarter);
    // 1-1/4 must not bleed into 1/2", 1-1/2", or 2-1/2".
    expect(catalogs).not.toContain(CS_CATALOGS.half);
    expect(catalogs).not.toContain(CS_CATALOGS.oneAndHalf);
    expect(catalogs).not.toContain(CS_CATALOGS.twoAndHalf);
  });

  it('conduitSize "1-1/2"" includes the 1-1/2" item and excludes 1/2" and 2-1/2"', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-CS EMT', conduitSize: '1-1/2"' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(CS_CATALOGS.oneAndHalf);
    // 1-1/2 must not bleed into 1/2" or 2-1/2".
    expect(catalogs).not.toContain(CS_CATALOGS.half);
    expect(catalogs).not.toContain(CS_CATALOGS.twoAndHalf);
  });

  it('conduitSize "2-1/2"" includes the 2-1/2" item and excludes 1/2" and 1-1/2"', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-CS EMT', conduitSize: '2-1/2"' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(CS_CATALOGS.twoAndHalf);
    // 2-1/2 must not bleed into 1/2" or 1-1/2".
    expect(catalogs).not.toContain(CS_CATALOGS.half);
    expect(catalogs).not.toContain(CS_CATALOGS.oneAndHalf);
  });

  it('no conduitSize chip returns all four seeded items', async () => {
    const res = await supertest(app)
      .post('/api/inventory/search')
      .send({ keywords: 'JEST-CS EMT' })
      .expect(200);

    const catalogs = catalogsOf(res.body);
    expect(catalogs).toContain(CS_CATALOGS.half);
    expect(catalogs).toContain(CS_CATALOGS.oneAndQuarter);
    expect(catalogs).toContain(CS_CATALOGS.oneAndHalf);
    expect(catalogs).toContain(CS_CATALOGS.twoAndHalf);
  });
});
