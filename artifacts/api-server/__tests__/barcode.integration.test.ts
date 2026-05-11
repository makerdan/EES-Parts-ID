/**
 * Integration tests for the barcode lookup + link endpoints.
 *
 * Backed by the same PostgreSQL database the other integration tests
 * use (DATABASE_URL). Fixture rows are namespaced under JEST-ITG-BC-
 * and cleaned up after the suite. inventory_barcode rows cascade-delete
 * with their parent inventory rows, so no separate barcode cleanup is needed.
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
import { sql } from 'drizzle-orm';
import app from '../src/app';
import { signAdminToken } from '../src/routes/admin';
import { db, inventoryTable, inventoryBarcodeTable } from '@workspace/db';
import { closePool, seedFixtures } from './helpers/testDb';

const ADMIN_SECRET = 'jest-barcode-test-secret';
let adminToken: string;

const BC_PREFIX = 'JEST-ITG-BC-';
const CAT_BREAKER = `${BC_PREFIX}BR120`;
const CAT_RECEPTACLE = `${BC_PREFIX}HBL5262`;
const CAT_OTHER = `${BC_PREFIX}OTHER`;

const UPC_BREAKER = '012345678905';
const UPC_RECEPTACLE = '098765432100';

let breakerId = 0;
let receptacleId = 0;
let otherId = 0;

async function cleanup() {
  // Delete bindings first (FK on inventory id cascades from inventory delete
  // anyway, but explicit cleanup is faster on busy CI databases).
  await db
    .delete(inventoryBarcodeTable)
    .where(
      sql`${inventoryBarcodeTable.barcode} ILIKE ${'%' + BC_PREFIX + '%'} OR ${inventoryBarcodeTable.barcode} IN (${UPC_BREAKER}, ${UPC_RECEPTACLE})`
    );
  await db.delete(inventoryTable).where(sql`${inventoryTable.catalog} LIKE ${BC_PREFIX + '%'}`);
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanup();
  const rows = await seedFixtures([
    {
      vendor: 'EATON',
      catalog: CAT_BREAKER,
      description: '1P 20A breaker',
      binLocations: ['A-01'],
    },
    {
      vendor: 'HUBBELL',
      catalog: CAT_RECEPTACLE,
      description: '20A duplex receptacle',
      binLocations: ['B-02'],
    },
    { vendor: 'LEVITON', catalog: CAT_OTHER, description: 'Other part', binLocations: ['C-03'] },
  ]);
  breakerId = rows.find((r) => r.catalog === CAT_BREAKER)!.id;
  receptacleId = rows.find((r) => r.catalog === CAT_RECEPTACLE)!.id;
  otherId = rows.find((r) => r.catalog === CAT_OTHER)!.id;
}, 30_000);

afterAll(async () => {
  await cleanup();
  await closePool();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// /api/barcode/lookup
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/barcode/lookup', () => {
  it('returns the catalog-matched item with source=catalog-auto', async () => {
    const res = await supertest(app)
      .post('/api/barcode/lookup')
      .send({ barcode: CAT_BREAKER })
      .expect(200);

    expect(res.body.match).toBeTruthy();
    expect(res.body.match.id).toBe(breakerId);
    expect(res.body.match.catalog).toBe(CAT_BREAKER);
    expect(res.body.source).toBe('catalog-auto');
    expect(Array.isArray(res.body.recentlyViewed)).toBe(true);
  });

  it('matches the catalog case-insensitively', async () => {
    const res = await supertest(app)
      .post('/api/barcode/lookup')
      .send({ barcode: CAT_RECEPTACLE.toLowerCase() })
      .expect(200);

    expect(res.body.match.id).toBe(receptacleId);
    expect(res.body.source).toBe('catalog-auto');
  });

  it('records the auto-match so a follow-up lookup uses the mapping table', async () => {
    // Trigger the auto-match the first time...
    await supertest(app).post('/api/barcode/lookup').send({ barcode: CAT_BREAKER }).expect(200);

    // ...then verify the binding row was written.
    const rows = await db
      .select()
      .from(inventoryBarcodeTable)
      .where(sql`upper(${inventoryBarcodeTable.barcode}) = ${CAT_BREAKER.toUpperCase()}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe('catalog-auto');
    expect(rows[0]!.inventoryId).toBe(breakerId);
  });

  it('returns the upc-linked item from the mapping table when catalog does not match', async () => {
    // Pre-link a UPC to the receptacle.
    await db
      .insert(inventoryBarcodeTable)
      .values({
        barcode: UPC_RECEPTACLE,
        inventoryId: receptacleId,
        source: 'upc-linked',
      })
      .onConflictDoNothing();

    const res = await supertest(app)
      .post('/api/barcode/lookup')
      .send({ barcode: UPC_RECEPTACLE })
      .expect(200);

    expect(res.body.match.id).toBe(receptacleId);
    expect(res.body.source).toBe('upc-linked');
  });

  it('returns null match + recentlyViewed for an unknown barcode', async () => {
    const res = await supertest(app)
      .post('/api/barcode/lookup')
      .send({ barcode: 'NEVER-SEEN-THIS-CODE-9999' })
      .expect(200);

    expect(res.body.match).toBeNull();
    expect(res.body.source).toBeNull();
    expect(Array.isArray(res.body.recentlyViewed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/barcode/link
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/barcode/link', () => {
  beforeEach(async () => {
    // Make sure the link-test barcodes start unbound for each test.
    await db
      .delete(inventoryBarcodeTable)
      .where(sql`${inventoryBarcodeTable.barcode} = ${UPC_BREAKER}`);
  });

  it('rejects unauthenticated link requests with 401', async () => {
    await supertest(app)
      .post('/api/barcode/link')
      .send({ barcode: UPC_BREAKER, inventoryId: breakerId })
      .expect(401);
    // No row was written.
    const rows = await db
      .select()
      .from(inventoryBarcodeTable)
      .where(sql`${inventoryBarcodeTable.barcode} = ${UPC_BREAKER}`);
    expect(rows.length).toBe(0);
  });

  it('rejects bogus admin tokens with 401', async () => {
    await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ barcode: UPC_BREAKER, inventoryId: breakerId })
      .expect(401);
  });

  it('creates a fresh binding (source=upc-linked)', async () => {
    const res = await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ barcode: UPC_BREAKER, inventoryId: breakerId })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.item.id).toBe(breakerId);

    const rows = await db
      .select()
      .from(inventoryBarcodeTable)
      .where(sql`${inventoryBarcodeTable.barcode} = ${UPC_BREAKER}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe('upc-linked');
  });

  it('is idempotent when the same barcode is re-linked to the same item', async () => {
    await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ barcode: UPC_BREAKER, inventoryId: breakerId })
      .expect(200);
    const res = await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ barcode: UPC_BREAKER, inventoryId: breakerId })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.item.id).toBe(breakerId);
  });

  it('returns 409 when the barcode is already bound to a different item', async () => {
    await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ barcode: UPC_BREAKER, inventoryId: breakerId })
      .expect(200);

    const res = await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ barcode: UPC_BREAKER, inventoryId: otherId })
      .expect(409);
    expect(res.body.currentInventoryId).toBe(breakerId);
  });

  it('overrides the binding when force=true is supplied', async () => {
    await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ barcode: UPC_BREAKER, inventoryId: breakerId })
      .expect(200);

    const res = await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ barcode: UPC_BREAKER, inventoryId: otherId, force: true })
      .expect(200);
    expect(res.body.item.id).toBe(otherId);

    const rows = await db
      .select()
      .from(inventoryBarcodeTable)
      .where(sql`${inventoryBarcodeTable.barcode} = ${UPC_BREAKER}`);
    expect(rows[0]!.inventoryId).toBe(otherId);
  });

  it('rejects an invalid inventoryId with 400', async () => {
    await supertest(app)
      .post('/api/barcode/link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ barcode: UPC_BREAKER, inventoryId: 0 })
      .expect(400);
  });
});
