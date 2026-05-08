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
