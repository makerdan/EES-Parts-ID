/**
 * Integration tests for the classification review queue endpoints:
 *
 *   GET  /api/admin/classification-review
 *   POST /api/admin/classification-review/:id/confirm
 *   POST /api/admin/classification-review/:id/reclassify
 *   POST /api/admin/classification-review/:id/skip
 *
 * Uses a real PostgreSQL database (DATABASE_URL env var).
 * OpenAI integration is mocked to avoid requiring a live API key.
 */

// ── Mock OpenAI BEFORE app is imported ───────────────────────────────────────
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
import { eq, sql, inArray } from 'drizzle-orm';
import app from '../src/app';
import { signAdminToken } from '../src/routes/admin';
import { db, inventoryTable, inventoryCategoryTable, categoryNodeTable } from '@workspace/db';
import { closePool } from './helpers/testDb';

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_SECRET = 'jest-cr-test-secret';
const CATALOG_PREFIX = 'JEST-ITG-CR-';
const SLUG_PREFIX = 'jest-itg-cr-';

let adminToken: string;

// IDs populated during beforeAll
let inv1Id: number; // ai, confidence=0.55, unreviewed → IN queue
let inv2Id: number; // ai, confidence=0.80, unreviewed → NOT in queue (above threshold)
let inv3Id: number; // ai, confidence=0.45, reviewed   → NOT in queue (already reviewed)
let inv4Id: number; // rule-classified                 → NOT in queue
let inv5Id: number; // ai, confidence=0.60, unreviewed → mutation tests (confirm)
let inv6Id: number; // ai, confidence=0.65, unreviewed → mutation tests (reclassify)
let inv7Id: number; // ai, confidence=0.50, unreviewed → mutation tests (skip)

let typeNodeId: number; // leaf ("type") node — valid assignment target
let subcatNodeId: number; // subcategory node — invalid for reclassify
let catNodeId: number; // category node    — invalid for reclassify
let altTypeNodeId: number; // second leaf node — used as reclassify target

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertInventoryItem(catalog: string): Promise<number> {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: 'JEST-VENDOR',
      catalog,
      description: `Integration test item ${catalog}`,
      binLocations: [],
      aiKeywords: [] as string[],
    })
    .onConflictDoNothing()
    .returning({ id: inventoryTable.id });
  return row!.id;
}

async function insertCategoryItem(
  inventoryId: number,
  nodeId: number,
  classifiedBy: 'ai' | 'rule' | 'manual',
  confidence: string,
  reviewed: boolean
) {
  await db
    .insert(inventoryCategoryTable)
    .values({
      inventoryId,
      categoryNodeId: nodeId,
      classifiedBy,
      confidence,
      reviewedAt: reviewed ? new Date('2025-01-01T00:00:00Z') : undefined,
      reviewedBy: reviewed ? 'admin' : undefined,
    })
    .onConflictDoNothing();
}

async function cleanupTestData(inventoryIds: number[]) {
  if (inventoryIds.length > 0) {
    await db
      .delete(inventoryCategoryTable)
      .where(inArray(inventoryCategoryTable.inventoryId, inventoryIds));
    await db
      .delete(inventoryTable)
      .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + '%'}`);
  }
  // Remove test category nodes by slug prefix
  await db
    .delete(categoryNodeTable)
    .where(sql`${categoryNodeTable.slug} LIKE ${SLUG_PREFIX + '%'}`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);

  // Clean up any leftover data from a previous interrupted run
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + '%'}`);
  await db
    .delete(categoryNodeTable)
    .where(sql`${categoryNodeTable.slug} LIKE ${SLUG_PREFIX + '%'}`);

  // ── Seed category taxonomy ─────────────────────────────────────────────────
  // category → subcategory → type (leaf)
  const [catNode] = await db
    .insert(categoryNodeTable)
    .values({
      level: 'category',
      name: 'Jest CR Category',
      slug: `${SLUG_PREFIX}cat`,
      sortOrder: 0,
    })
    .returning({ id: categoryNodeTable.id });
  catNodeId = catNode!.id;

  const [subcatNode] = await db
    .insert(categoryNodeTable)
    .values({
      parentId: catNodeId,
      level: 'subcategory',
      name: 'Jest CR Subcategory',
      slug: `${SLUG_PREFIX}subcat`,
      sortOrder: 0,
    })
    .returning({ id: categoryNodeTable.id });
  subcatNodeId = subcatNode!.id;

  const [typeNode] = await db
    .insert(categoryNodeTable)
    .values({
      parentId: subcatNodeId,
      level: 'type',
      name: 'Jest CR Type',
      slug: `${SLUG_PREFIX}type`,
      sortOrder: 0,
    })
    .returning({ id: categoryNodeTable.id });
  typeNodeId = typeNode!.id;

  const [altTypeNode] = await db
    .insert(categoryNodeTable)
    .values({
      parentId: subcatNodeId,
      level: 'type',
      name: 'Jest CR Alt Type',
      slug: `${SLUG_PREFIX}alt-type`,
      sortOrder: 1,
    })
    .returning({ id: categoryNodeTable.id });
  altTypeNodeId = altTypeNode!.id;

  // ── Seed inventory items ───────────────────────────────────────────────────
  inv1Id = await insertInventoryItem(`${CATALOG_PREFIX}001`);
  inv2Id = await insertInventoryItem(`${CATALOG_PREFIX}002`);
  inv3Id = await insertInventoryItem(`${CATALOG_PREFIX}003`);
  inv4Id = await insertInventoryItem(`${CATALOG_PREFIX}004`);
  inv5Id = await insertInventoryItem(`${CATALOG_PREFIX}005`);
  inv6Id = await insertInventoryItem(`${CATALOG_PREFIX}006`);
  inv7Id = await insertInventoryItem(`${CATALOG_PREFIX}007`);

  // ── Seed inventory_category rows ───────────────────────────────────────────
  await insertCategoryItem(inv1Id, typeNodeId, 'ai', '0.5500', false); // IN queue
  await insertCategoryItem(inv2Id, typeNodeId, 'ai', '0.8000', false); // above 0.70 → excluded
  await insertCategoryItem(inv3Id, typeNodeId, 'ai', '0.4500', true); // already reviewed → excluded
  await insertCategoryItem(inv4Id, typeNodeId, 'rule', '1.0000', false); // rule-classified → excluded
  await insertCategoryItem(inv5Id, typeNodeId, 'ai', '0.6000', false); // IN queue (confirm target)
  await insertCategoryItem(inv6Id, typeNodeId, 'ai', '0.6500', false); // IN queue (reclassify target)
  await insertCategoryItem(inv7Id, typeNodeId, 'ai', '0.5000', false); // IN queue (skip target)
}, 30_000);

afterAll(async () => {
  await cleanupTestData([inv1Id, inv2Id, inv3Id, inv4Id, inv5Id, inv6Id, inv7Id]);
  await closePool();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// 401 — all endpoints require a valid admin token
// ─────────────────────────────────────────────────────────────────────────────

describe('Authentication — all classification-review endpoints require a valid admin token', () => {
  it('GET /api/admin/classification-review returns 401 without a token', async () => {
    await supertest(app).get('/api/admin/classification-review').expect(401);
  });

  it('GET /api/admin/classification-review returns 401 with an invalid token', async () => {
    await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', 'Bearer totally-invalid-token')
      .expect(401);
  });

  it('POST confirm returns 401 without a token', async () => {
    await supertest(app).post(`/api/admin/classification-review/${inv1Id}/confirm`).expect(401);
  });

  it('POST confirm returns 401 with an invalid token', async () => {
    await supertest(app)
      .post(`/api/admin/classification-review/${inv1Id}/confirm`)
      .set('Authorization', 'Bearer totally-invalid-token')
      .expect(401);
  });

  it('POST reclassify returns 401 without a token', async () => {
    await supertest(app)
      .post(`/api/admin/classification-review/${inv1Id}/reclassify`)
      .send({ categoryNodeId: typeNodeId })
      .expect(401);
  });

  it('POST reclassify returns 401 with an invalid token', async () => {
    await supertest(app)
      .post(`/api/admin/classification-review/${inv1Id}/reclassify`)
      .set('Authorization', 'Bearer totally-invalid-token')
      .send({ categoryNodeId: typeNodeId })
      .expect(401);
  });

  it('POST skip returns 401 without a token', async () => {
    await supertest(app).post(`/api/admin/classification-review/${inv1Id}/skip`).expect(401);
  });

  it('POST skip returns 401 with an invalid token', async () => {
    await supertest(app)
      .post(`/api/admin/classification-review/${inv1Id}/skip`)
      .set('Authorization', 'Bearer totally-invalid-token')
      .expect(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/classification-review
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/classification-review', () => {
  it('returns 200 with items, total, page, and limit fields', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('limit');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('includes ai-classified unreviewed items with confidence < 0.70', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ids = res.body.items.map((i: { inventoryId: number }) => i.inventoryId);
    expect(ids).toContain(inv1Id);
  });

  it('excludes ai-classified items with confidence >= 0.70', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ids = res.body.items.map((i: { inventoryId: number }) => i.inventoryId);
    expect(ids).not.toContain(inv2Id);
  });

  it('excludes ai-classified items that have already been reviewed', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ids = res.body.items.map((i: { inventoryId: number }) => i.inventoryId);
    expect(ids).not.toContain(inv3Id);
  });

  it('excludes rule-classified items regardless of confidence', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ids = res.body.items.map((i: { inventoryId: number }) => i.inventoryId);
    expect(ids).not.toContain(inv4Id);
  });

  it('returns items with expected shape (inventoryId, confidencePct, categoryPath, etc.)', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const item = res.body.items.find((i: { inventoryId: number }) => i.inventoryId === inv1Id);
    expect(item).toBeDefined();
    expect(typeof item.inventoryId).toBe('number');
    expect(typeof item.confidencePct).toBe('number');
    expect(typeof item.categoryPath).toBe('string');
    expect(typeof item.classifiedAt).toBe('string');
    expect(typeof item.categoryNodeId).toBe('number');
    expect(item.categoryNodeId).toBe(typeNodeId);
  });

  it('respects the limit query parameter', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review?limit=1')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.items.length).toBeLessThanOrEqual(1);
    expect(res.body.limit).toBe(1);
  });

  it('respects the page query parameter', async () => {
    const page1 = await supertest(app)
      .get('/api/admin/classification-review?limit=1&page=1')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const page2 = await supertest(app)
      .get('/api/admin/classification-review?limit=1&page=2')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // If there are at least 2 items, the two pages should return different items
    if (page1.body.total >= 2) {
      expect(page1.body.items[0]?.inventoryId).not.toBe(page2.body.items[0]?.inventoryId);
    }
    expect(page1.body.page).toBe(1);
    expect(page2.body.page).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/classification-review/:id/confirm
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/classification-review/:id/confirm', () => {
  it('returns 200 with ok:true for a valid queue item', async () => {
    const res = await supertest(app)
      .post(`/api/admin/classification-review/${inv5Id}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.inventoryId).toBe(inv5Id);
  });

  it('sets reviewed_at on the row (removes it from the queue)', async () => {
    // inv5Id was confirmed above — it should no longer appear in the queue
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ids = res.body.items.map((i: { inventoryId: number }) => i.inventoryId);
    expect(ids).not.toContain(inv5Id);
  });

  it('does not change the categoryNodeId', async () => {
    const [row] = await db
      .select({
        categoryNodeId: inventoryCategoryTable.categoryNodeId,
        classifiedBy: inventoryCategoryTable.classifiedBy,
      })
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, inv5Id))
      .limit(1);

    expect(row!.categoryNodeId).toBe(typeNodeId);
    expect(row!.classifiedBy).toBe('ai'); // confirm does not change classifiedBy
  });

  it('returns 404 when the item is already reviewed', async () => {
    // inv5Id is now reviewed — attempting to confirm again should 404
    await supertest(app)
      .post(`/api/admin/classification-review/${inv5Id}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('returns 404 for an inventory item not in the queue', async () => {
    await supertest(app)
      .post('/api/admin/classification-review/999999999/confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('returns 400 for a non-integer id', async () => {
    await supertest(app)
      .post('/api/admin/classification-review/abc/confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/classification-review/:id/reclassify
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/classification-review/:id/reclassify', () => {
  it('returns 400 when targeting a non-leaf (category) node', async () => {
    const res = await supertest(app)
      .post(`/api/admin/classification-review/${inv6Id}/reclassify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ categoryNodeId: catNodeId })
      .expect(400);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/leaf type node/i);
  });

  it('returns 400 when targeting a non-leaf (subcategory) node', async () => {
    const res = await supertest(app)
      .post(`/api/admin/classification-review/${inv6Id}/reclassify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ categoryNodeId: subcatNodeId })
      .expect(400);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/leaf type node/i);
  });

  it('returns 200 with ok:true when targeting a valid leaf (type) node', async () => {
    const res = await supertest(app)
      .post(`/api/admin/classification-review/${inv6Id}/reclassify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ categoryNodeId: altTypeNodeId })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.inventoryId).toBe(inv6Id);
    expect(res.body.categoryNodeId).toBe(altTypeNodeId);
  });

  it("updates categoryNodeId, sets classifiedBy to 'manual', and sets confidence to 1.0 in the database", async () => {
    const [row] = await db
      .select({
        categoryNodeId: inventoryCategoryTable.categoryNodeId,
        classifiedBy: inventoryCategoryTable.classifiedBy,
        confidence: inventoryCategoryTable.confidence,
        reviewedAt: inventoryCategoryTable.reviewedAt,
        reviewedBy: inventoryCategoryTable.reviewedBy,
      })
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, inv6Id))
      .limit(1);

    expect(row!.categoryNodeId).toBe(altTypeNodeId);
    expect(row!.classifiedBy).toBe('manual');
    expect(parseFloat(row!.confidence)).toBe(1.0);
    expect(row!.reviewedAt).not.toBeNull();
    expect(row!.reviewedBy).toBe('admin');
  });

  it('removes the reclassified item from the review queue', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ids = res.body.items.map((i: { inventoryId: number }) => i.inventoryId);
    expect(ids).not.toContain(inv6Id);
  });

  it('returns 404 when the item is already reviewed', async () => {
    // inv6Id is now reviewed — reclassify again should 404
    await supertest(app)
      .post(`/api/admin/classification-review/${inv6Id}/reclassify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ categoryNodeId: altTypeNodeId })
      .expect(404);
  });

  it('returns 404 when the target categoryNodeId does not exist', async () => {
    await supertest(app)
      .post(`/api/admin/classification-review/${inv1Id}/reclassify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ categoryNodeId: 999999999 })
      .expect(404);
  });

  it('returns 400 when categoryNodeId is missing from the body', async () => {
    await supertest(app)
      .post(`/api/admin/classification-review/${inv1Id}/reclassify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);
  });

  it('returns 400 for a non-integer inventory id', async () => {
    await supertest(app)
      .post('/api/admin/classification-review/not-a-number/reclassify')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ categoryNodeId: altTypeNodeId })
      .expect(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/classification-review/:id/skip
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/classification-review/:id/skip', () => {
  let classifiedAtBefore: Date;

  beforeAll(async () => {
    // Record the current classified_at so we can verify it was bumped
    const [row] = await db
      .select({ classifiedAt: inventoryCategoryTable.classifiedAt })
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, inv7Id))
      .limit(1);
    classifiedAtBefore = row!.classifiedAt;
  });

  it('returns 200 with ok:true for a valid queue item', async () => {
    const res = await supertest(app)
      .post(`/api/admin/classification-review/${inv7Id}/skip`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.inventoryId).toBe(inv7Id);
  });

  it('bumps classified_at to a later timestamp', async () => {
    const [row] = await db
      .select({ classifiedAt: inventoryCategoryTable.classifiedAt })
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, inv7Id))
      .limit(1);

    expect(row!.classifiedAt.getTime()).toBeGreaterThan(classifiedAtBefore.getTime());
  });

  it('does not set reviewed_at (item stays in the queue)', async () => {
    const [row] = await db
      .select({ reviewedAt: inventoryCategoryTable.reviewedAt })
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, inv7Id))
      .limit(1);

    expect(row!.reviewedAt).toBeNull();
  });

  it('item still appears in the review queue after skip', async () => {
    const res = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ids = res.body.items.map((i: { inventoryId: number }) => i.inventoryId);
    expect(ids).toContain(inv7Id);
  });

  it('returns 404 for an inventory item not in the queue', async () => {
    await supertest(app)
      .post('/api/admin/classification-review/999999999/skip')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('returns 400 for a non-integer id', async () => {
    await supertest(app)
      .post('/api/admin/classification-review/bad/skip')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review-queue deduplication — re-classifying an already-queued item
// ─────────────────────────────────────────────────────────────────────────────

describe('Review queue deduplication — re-classifying an already-queued item', () => {
  let dedupInvId: number;

  beforeAll(async () => {
    dedupInvId = await insertInventoryItem(`${CATALOG_PREFIX}DEDUP`);
  });

  afterAll(async () => {
    await db
      .delete(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, dedupInvId));
    await db.delete(inventoryTable).where(eq(inventoryTable.id, dedupInvId));
  });

  it('upserting a second low-confidence AI classification leaves exactly one row', async () => {
    const upsert = (nodeId: number, confidence: string) =>
      db
        .insert(inventoryCategoryTable)
        .values({
          inventoryId: dedupInvId,
          categoryNodeId: nodeId,
          classifiedBy: 'ai',
          confidence,
        })
        .onConflictDoUpdate({
          target: inventoryCategoryTable.inventoryId,
          set: {
            categoryNodeId: nodeId,
            classifiedBy: 'ai',
            confidence,
            classifiedAt: sql`now()`,
            reviewedAt: null,
            reviewedBy: null,
          },
        });

    await upsert(typeNodeId, '0.5000');
    await upsert(altTypeNodeId, '0.4500');

    const rows = await db
      .select()
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, dedupInvId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.categoryNodeId).toBe(altTypeNodeId);
    expect(parseFloat(rows[0]!.confidence)).toBeCloseTo(0.45);
  });

  it('the queue total does not grow when re-classifying an already-queued item', async () => {
    const before = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const totalBefore: number = before.body.total;

    await db
      .insert(inventoryCategoryTable)
      .values({
        inventoryId: dedupInvId,
        categoryNodeId: typeNodeId,
        classifiedBy: 'ai',
        confidence: '0.5500',
      })
      .onConflictDoUpdate({
        target: inventoryCategoryTable.inventoryId,
        set: {
          categoryNodeId: typeNodeId,
          classifiedBy: 'ai',
          confidence: '0.5500',
          classifiedAt: sql`now()`,
          reviewedAt: null,
          reviewedBy: null,
        },
      });

    const after = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(after.body.total).toBe(totalBefore);
  });

  it('upserting a classification resets reviewed_at to NULL (item re-enters queue)', async () => {
    await db
      .update(inventoryCategoryTable)
      .set({ reviewedAt: new Date('2025-06-01T00:00:00Z'), reviewedBy: 'admin' })
      .where(eq(inventoryCategoryTable.inventoryId, dedupInvId));

    await db
      .insert(inventoryCategoryTable)
      .values({
        inventoryId: dedupInvId,
        categoryNodeId: typeNodeId,
        classifiedBy: 'ai',
        confidence: '0.6000',
      })
      .onConflictDoUpdate({
        target: inventoryCategoryTable.inventoryId,
        set: {
          categoryNodeId: typeNodeId,
          classifiedBy: 'ai',
          confidence: '0.6000',
          classifiedAt: sql`now()`,
          reviewedAt: null,
          reviewedBy: null,
        },
      });

    const [row] = await db
      .select({ reviewedAt: inventoryCategoryTable.reviewedAt })
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, dedupInvId))
      .limit(1);

    expect(row!.reviewedAt).toBeNull();
  });

  it('re-running /categories/classify on an already-queued item does not increase the queue total', async () => {
    // Ensure the item starts as an AI low-confidence queue entry.
    await db
      .insert(inventoryCategoryTable)
      .values({
        inventoryId: dedupInvId,
        categoryNodeId: typeNodeId,
        classifiedBy: 'ai',
        confidence: '0.5000',
      })
      .onConflictDoUpdate({
        target: inventoryCategoryTable.inventoryId,
        set: {
          categoryNodeId: typeNodeId,
          classifiedBy: 'ai',
          confidence: '0.5000',
          classifiedAt: sql`now()`,
          reviewedAt: null,
          reviewedBy: null,
        },
      });

    const before = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const totalBefore: number = before.body.total;

    // Call the real classify endpoint with mode="specific-ids" so the
    // writeAssignment upsert path is exercised end-to-end.
    // useAi=false avoids calling the mocked OpenAI client.
    await supertest(app)
      .post('/api/categories/classify')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'specific-ids', ids: [dedupInvId], useAi: false })
      .buffer(true)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => callback(null, data));
      })
      .expect(200);

    // Exactly one row for this item must still exist.
    const rows = await db
      .select()
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, dedupInvId));
    expect(rows).toHaveLength(1);

    // Queue total must not have grown.
    const after = await supertest(app)
      .get('/api/admin/classification-review')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(after.body.total).toBeLessThanOrEqual(totalBefore);
  });
});
