/**
 * Integration tests for the catalog-PDF enrichment routes:
 *   POST /api/admin/catalog-pdf/preview
 *   POST /api/admin/catalog-pdf/apply
 *
 * Uses the real Bridgeport Fittings 2026 PDF fixture and the real Postgres
 * database. Seeds a small set of inventory rows, asserts the classifier
 * produces sane tier counts, applies the report, and verifies enrichment
 * landed correctly — including that color-suffixed siblings (e.g. -SBLU vs
 * the seeded -SBLK) are NOT collapsed into a single inventory row.
 */

// ── Mock OpenAI BEFORE app is imported (matches sibling integration tests) ──
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

import path from 'node:path';
import fs from 'node:fs';
import supertest from 'supertest';
import { and, eq, inArray } from 'drizzle-orm';
import app from '../src/app';
import { signAdminToken } from '../src/routes/admin';
import { db, inventoryTable } from '@workspace/db';
import { closePool, cleanupFixtures } from './helpers/testDb';

const ADMIN_SECRET = 'jest-catalog-pdf-test-secret';
let adminToken: string;

const FIXTURE_CATALOGS = ['239-DC2', '231-SBLK', '236-DC'] as const;
const PDF_PATH = path.resolve(
  __dirname,
  '../../../attached_assets/Bridgeport_Fittings_2026_Catalog_Part1_1777767002957.pdf'
);
const haveFixture = fs.existsSync(PDF_PATH);

async function cleanupRows() {
  await db
    .delete(inventoryTable)
    .where(
      and(
        eq(inventoryTable.vendor, 'BRIDGEPORT'),
        inArray(inventoryTable.catalog, [...FIXTURE_CATALOGS])
      )
    );
}

async function seedRows() {
  await cleanupRows();
  for (const catalog of FIXTURE_CATALOGS) {
    await db.insert(inventoryTable).values({ vendor: 'BRIDGEPORT', catalog, description: '' });
  }
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
}, 30_000);

afterAll(async () => {
  await cleanupRows();
  await cleanupFixtures();
  await closePool();
}, 30_000);

afterEach(async () => {
  await cleanupRows();
});

const describeIfFixture = haveFixture ? describe : describe.skip;

describeIfFixture('POST /api/admin/catalog-pdf/preview + /apply (Bridgeport)', () => {
  it('returns 401 without an admin token', async () => {
    const res = await supertest(app)
      .post('/api/admin/catalog-pdf/preview?vendor=Bridgeport')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4\n'))
      .expect(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 415 when Content-Type is neither multipart nor application/pdf', async () => {
    const res = await supertest(app)
      .post('/api/admin/catalog-pdf/preview?vendor=Bridgeport')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/json')
      .send({ vendor: 'Bridgeport' })
      .expect(415);
    expect(res.body.error).toMatch(/multipart|application\/pdf/i);
  });

  it('returns 400 when vendor is missing', async () => {
    const res = await supertest(app)
      .post('/api/admin/catalog-pdf/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', PDF_PATH, { contentType: 'application/pdf' })
      .expect(400);
    expect(res.body.error).toMatch(/vendor/i);
  });

  it('rejects non-PDF bodies on the raw path', async () => {
    const res = await supertest(app)
      .post('/api/admin/catalog-pdf/preview?vendor=Bridgeport')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('not a pdf'))
      .expect(400);
    expect(res.body.error).toMatch(/PDF/);
  });

  it('multipart preview parses, classifies, and apply enriches the right rows', async () => {
    await seedRows();

    // ── /preview via multipart ──
    const previewRes = await supertest(app)
      .post('/api/admin/catalog-pdf/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('vendor', 'Bridgeport')
      .attach('file', PDF_PATH, { contentType: 'application/pdf' })
      .expect(200);

    const report = previewRes.body as {
      vendor: string;
      summary: {
        exact: number;
        highConfidence: number;
        uncertain: number;
        unmatched: number;
        total: number;
      };
      rows: Array<{
        catalogNumber: string;
        tier: 'exact' | 'highConfidence' | 'uncertain' | 'unmatched';
        candidates: Array<{ inventoryId: number; catalog: string }>;
      }>;
    };

    expect(report.vendor).toBe('BRIDGEPORT');
    expect(report.summary.total).toBeGreaterThan(3000);
    expect(report.summary.exact).toBeGreaterThanOrEqual(2); // 239-DC2, 236-DC
    expect(report.summary.highConfidence).toBeGreaterThanOrEqual(1); // 239-DC2 sibling row
    expect(report.summary.unmatched).toBeGreaterThan(report.summary.total / 2);

    // 239-DC2 must be exact-matched against the seeded 239-DC2 row.
    const exact239 = report.rows.find((r) => r.catalogNumber === '239-DC2' && r.tier === 'exact');
    expect(exact239).toBeDefined();
    expect(exact239!.candidates[0]?.catalog).toBe('239-DC2');

    // 231-SBLK must NOT collapse other color suffixes (-SBLU/-SR/-SY/...).
    const colorSiblings = report.rows.filter((r) => /^231-S(BLU|R|Y|W|G|O)$/.test(r.catalogNumber));
    for (const r of colorSiblings) {
      expect(r.tier).not.toBe('highConfidence');
      expect(r.tier).not.toBe('exact');
    }

    // ── /apply via {report, uncertainDecisions:{}} ──
    const applyRes = await supertest(app)
      .post('/api/admin/catalog-pdf/apply')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ report, uncertainDecisions: {} })
      .expect(200);

    const applyBody = applyRes.body as {
      updated: number;
      skippedNoOp: number;
      errors: Array<{ inventoryId: number; error: string }>;
    };
    expect(applyBody.errors).toEqual([]);
    expect(applyBody.updated + applyBody.skippedNoOp).toBeGreaterThanOrEqual(3);

    // ── Verify each seeded row was enriched ──
    const enriched = await db
      .select()
      .from(inventoryTable)
      .where(
        and(
          eq(inventoryTable.vendor, 'BRIDGEPORT'),
          inArray(inventoryTable.catalog, [...FIXTURE_CATALOGS])
        )
      );
    expect(enriched).toHaveLength(3);
    for (const row of enriched) {
      expect(row.enrichedAt).not.toBeNull();
      expect(row.aiKeywords.length).toBeGreaterThan(0);
      expect(row.aiKeywords.map((k) => k.toLowerCase())).toContain('bridgeport fittings');
    }

    // 231-SBLK must carry "black" but NOT blue/red/yellow/etc. (color-confusion guard).
    const sblk = enriched.find((r) => r.catalog === '231-SBLK');
    expect(sblk).toBeDefined();
    const lowerKeys = sblk!.aiKeywords.map((k) => k.toLowerCase());
    expect(lowerKeys).toContain('black');
    for (const wrongColor of ['blue', 'red', 'yellow', 'white', 'gray', 'orange']) {
      expect(lowerKeys).not.toContain(wrongColor);
    }
  }, 60_000);

  it('apply returns 400 when report is missing', async () => {
    const res = await supertest(app)
      .post('/api/admin/catalog-pdf/apply')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ uncertainDecisions: {} })
      .expect(400);
    expect(res.body.error).toMatch(/report/);
  });
});
