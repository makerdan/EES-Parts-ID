/**
 * Integration tests for:
 *   GET  /api/series/search?q=        — search series by name/vendor (admin-gated)
 *   PATCH /api/inventory/:id/series   — assign or clear series_id (admin-gated)
 *
 * Isolation:
 *   - Inventory rows use the JEST-SA- catalog prefix and are cleaned up by prefix.
 *   - product_series rows created here are deleted by name prefix in afterAll.
 */

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

import supertest from 'supertest';
import { eq, sql, ilike } from 'drizzle-orm';
import app from '../src/app';
import { signAdminToken } from '../src/routes/admin';
import { db, inventoryTable, productSeriesTable } from '@workspace/db';
import { closePool } from './helpers/testDb';

const ADMIN_SECRET = 'jest-series-assign-secret';
const CATALOG_PREFIX = 'JEST-SA-';
const SERIES_NAME = 'JEST-SA-TestSeries';

let adminToken: string;
let inventoryId: number;
let seriesId: number;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);

  // Seed one inventory row
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: 'EATON',
      catalog: `${CATALOG_PREFIX}BR120`,
      description: 'Test breaker for series assign',
      aiKeywords: [] as string[],
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new Error('Failed to seed inventory fixture');
  inventoryId = row.id;

  // Seed one product_series row
  const [series] = await db
    .insert(productSeriesTable)
    .values({ vendor: 'EATON', name: SERIES_NAME })
    .onConflictDoNothing()
    .returning();
  if (!series) {
    const existing = await db
      .select()
      .from(productSeriesTable)
      .where(eq(productSeriesTable.name, SERIES_NAME))
      .limit(1);
    seriesId = (existing[0] as { id: number }).id;
  } else {
    seriesId = series.id;
  }
});

afterAll(async () => {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + '%'}`);
  await db.delete(productSeriesTable).where(ilike(productSeriesTable.name, 'JEST-SA-%'));
  await closePool();
});

// ── GET /api/series/search ────────────────────────────────────────────────────

describe('GET /api/series/search', () => {
  it('returns 401 without admin token', async () => {
    await supertest(app).get('/api/series/search').expect(401);
  });

  it('returns the seeded series when q matches name', async () => {
    const res = await supertest(app)
      .get(`/api/series/search?q=${encodeURIComponent(SERIES_NAME)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const ids = (res.body.series as Array<{ id: number }>).map((s) => s.id);
    expect(ids).toContain(seriesId);
  });

  it('returns the seeded series when q matches vendor EATON', async () => {
    const res = await supertest(app)
      .get('/api/series/search?q=EATON')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const ids = (res.body.series as Array<{ id: number }>).map((s) => s.id);
    expect(ids).toContain(seriesId);
  });

  it('returns empty array for a query that matches nothing', async () => {
    const res = await supertest(app)
      .get('/api/series/search?q=ZZZNOMATCH999JEST')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.series).toHaveLength(0);
  });

  it('returns a non-empty list with well-shaped rows when q is empty', async () => {
    const res = await supertest(app)
      .get('/api/series/search')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const series = res.body.series as Array<{ id: number; name: string; vendor: string }>;
    // The endpoint paginates — the seeded row may not be on the first page when
    // the database has many series. Validate structure only here; membership is
    // already covered by the name-based and vendor-based search tests above.
    expect(Array.isArray(series)).toBe(true);
    expect(series.length).toBeGreaterThan(0);
    for (const row of series) {
      expect(typeof row.id).toBe('number');
      expect(typeof row.name).toBe('string');
      expect(typeof row.vendor).toBe('string');
    }
  });

  it('each result row has id, name, and vendor fields', async () => {
    const res = await supertest(app)
      .get(`/api/series/search?q=${encodeURIComponent(SERIES_NAME)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = (res.body.series as Array<{ id: number; name: string; vendor: string }>).find(
      (s) => s.id === seriesId
    );
    expect(row).toBeDefined();
    expect(typeof row!.id).toBe('number');
    expect(row!.name).toBe(SERIES_NAME);
    expect(row!.vendor).toBe('EATON');
  });
});

// ── PATCH /api/inventory/:id/series ──────────────────────────────────────────

describe('PATCH /api/inventory/:id/series', () => {
  afterEach(async () => {
    // Reset series_id to null after each test so tests are independent
    await db
      .update(inventoryTable)
      .set({ seriesId: null })
      .where(eq(inventoryTable.id, inventoryId));
  });

  it('returns 401 without admin token', async () => {
    await supertest(app)
      .patch(`/api/inventory/${inventoryId}/series`)
      .send({ seriesId: null })
      .expect(401);
  });

  it('returns 400 when seriesId is missing from body', async () => {
    await supertest(app)
      .patch(`/api/inventory/${inventoryId}/series`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);
  });

  it('returns 400 for a non-numeric seriesId', async () => {
    await supertest(app)
      .patch(`/api/inventory/${inventoryId}/series`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ seriesId: 'not-a-number' })
      .expect(400);
  });

  it('returns 404 when the target series does not exist', async () => {
    await supertest(app)
      .patch(`/api/inventory/${inventoryId}/series`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ seriesId: 999999999 })
      .expect(404);
  });

  it('assigns seriesId and returns seriesName resolved from DB', async () => {
    const res = await supertest(app)
      .patch(`/api/inventory/${inventoryId}/series`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ seriesId })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.seriesName).toBe(SERIES_NAME);
  });

  it('persists series_id in the database', async () => {
    await supertest(app)
      .patch(`/api/inventory/${inventoryId}/series`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ seriesId })
      .expect(200);

    const [row] = await db
      .select({ seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, inventoryId))
      .limit(1);
    expect(row?.seriesId).toBe(seriesId);
  });

  it('clears series_id when null is sent and returns null seriesName', async () => {
    await supertest(app)
      .patch(`/api/inventory/${inventoryId}/series`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ seriesId })
      .expect(200);

    const res = await supertest(app)
      .patch(`/api/inventory/${inventoryId}/series`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ seriesId: null })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.seriesName).toBeNull();

    const [row] = await db
      .select({ seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, inventoryId))
      .limit(1);
    expect(row?.seriesId).toBeNull();
  });
});
