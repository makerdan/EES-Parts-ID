/**
 * Integration tests for POST /api/admin/upload.
 *
 * The route accepts a raw CSV string, parses it server-side, and upserts rows
 * into the inventory table.  OpenAI is mocked; the real PostgreSQL DB is used.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
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
import { cleanupFixtures, closePool } from './helpers/testDb';
import { db, inventoryTable } from '@workspace/db';
import { sql } from 'drizzle-orm';

// ── Setup / teardown ──────────────────────────────────────────────────────────
const ADMIN_SECRET = 'jest-upload-test-secret';
let adminToken: string;

const UPLOAD_PREFIX = 'JEST-UPLOAD-';

async function cleanupUploads() {
  await db.delete(inventoryTable).where(sql`${inventoryTable.catalog} LIKE ${'JEST-UPLOAD-%'}`);
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanupUploads();
}, 30_000);

afterAll(async () => {
  await cleanupUploads();
  await cleanupFixtures(); // belt-and-suspenders
  await closePool();
}, 30_000);

afterEach(async () => {
  await cleanupUploads();
});

// ── Helper ─────────────────────────────────────────────────────────────────────
function buildCsv(rows: string[][]): string {
  return ['Vendor,Catalog,Description,BinLocation', ...rows.map((r) => r.join(','))].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/upload
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/upload', () => {
  // ── Auth ──
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await supertest(app)
      .post('/api/admin/upload')
      .send({ csv: buildCsv([['ACME', `${UPLOAD_PREFIX}001`, 'Widget', 'A1']]) })
      .expect(401);

    expect(res.body).toHaveProperty('error');
  });

  it('returns 401 when an invalid token is provided', async () => {
    await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', 'Bearer bad-token')
      .send({ csv: buildCsv([['ACME', `${UPLOAD_PREFIX}001`, 'Widget', 'A1']]) })
      .expect(401);
  });

  // ── Malformed CSV → 400 ──
  it('returns 400 when the csv field is missing', async () => {
    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);

    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when the csv string is empty', async () => {
    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv: '   ' })
      .expect(400);

    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when the CSV has only a header row and no data rows', async () => {
    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv: 'Vendor,Catalog,Description' })
      .expect(400);

    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when the CSV is missing required Vendor column', async () => {
    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv: 'Catalog,Description\n${UPLOAD_PREFIX}001,Widget' })
      .expect(400);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/malformed|vendor|catalog/i);
  });

  it('returns 400 when the CSV is missing required Catalog column', async () => {
    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv: 'Vendor,Description\nACME,Widget' })
      .expect(400);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/malformed|vendor|catalog/i);
  });

  // ── Valid CSV → 200 ──
  it('inserts new rows from a valid CSV and reports the correct row count', async () => {
    const csv = buildCsv([
      ['JEST-VENDOR', `${UPLOAD_PREFIX}001`, 'Test breaker', 'B-01'],
      ['JEST-VENDOR', `${UPLOAD_PREFIX}002`, 'Test receptacle', 'C-02'],
    ]);

    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.inserted).toBe(2);
    expect(res.body.updated).toBe(0);
    expect(res.body.total).toBe(2);
  });

  it('updates an existing row when the same vendor+catalog is uploaded again', async () => {
    const firstCsv = buildCsv([['JEST-VENDOR', `${UPLOAD_PREFIX}001`, 'Original description', '']]);
    await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv: firstCsv })
      .expect(200);

    const secondCsv = buildCsv([
      ['JEST-VENDOR', `${UPLOAD_PREFIX}001`, 'Updated description', 'D-99'],
    ]);
    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv: secondCsv })
      .expect(200);

    expect(res.body.inserted).toBe(0);
    expect(res.body.updated).toBe(1);
    expect(res.body.total).toBe(1);
  });

  it('skips CSV rows where vendor or catalog is blank', async () => {
    // Row 1: valid; Row 2: missing catalog; Row 3: missing vendor
    const csv = [
      'Vendor,Catalog,Description',
      `JEST-VENDOR,${UPLOAD_PREFIX}001,Good row`,
      `JEST-VENDOR,,No catalog`,
      `,${UPLOAD_PREFIX}002,No vendor`,
    ].join('\n');

    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    // Only the valid row should be processed
    expect(res.body.total).toBe(1);
    expect(res.body.inserted).toBe(1);
  });

  it('handles quoted fields with commas inside correctly', async () => {
    const csv = [
      'Vendor,Catalog,Description,BinLocation',
      `JEST-VENDOR,${UPLOAD_PREFIX}QUOTED,"Breaker, 20A, 1 Pole",A-1`,
    ].join('\n');

    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.inserted).toBe(1);
    expect(res.body.total).toBe(1);
  });

  // ── Multi-bin behavior ─────────────────────────────────────────────────
  it('splits a single bin cell containing multiple bins (`,` `;` `/` `\\n`) into an array', async () => {
    const csv = [
      'Vendor,Catalog,Description,BinLocation',
      // Comma separator inside a quoted cell (otherwise it'd be field break).
      `JEST-VENDOR,${UPLOAD_PREFIX}MULTI1,Comma-sep,"A-1, A-2, A-3"`,
      // Bare semicolon and slash separators don't need quoting.
      `JEST-VENDOR,${UPLOAD_PREFIX}MULTI2,Semi-sep,B-1;B-2;B-3`,
      `JEST-VENDOR,${UPLOAD_PREFIX}MULTI3,Slash-sep,C-1/C-2/C-3`,
      // Quoted multi-line cell — newlines inside quotes must be honoured by
      // the parser so all bins survive (regression test for the previous
      // line-by-line CSV split that silently dropped trailing bins).
      `JEST-VENDOR,${UPLOAD_PREFIX}MULTI4,Newline-sep,"D-1\nD-2\nD-3"`,
    ].join('\n');

    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    expect(res.body.inserted).toBe(4);

    const rows = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} LIKE ${UPLOAD_PREFIX + 'MULTI%'}`)
      .orderBy(inventoryTable.catalog);

    expect(rows.map((r) => r.binLocations)).toEqual([
      ['A-1', 'A-2', 'A-3'],
      ['B-1', 'B-2', 'B-3'],
      ['C-1', 'C-2', 'C-3'],
      ['D-1', 'D-2', 'D-3'],
    ]);
  });

  it('merges bins additively across two CSV rows for the same part', async () => {
    const csv = [
      'Vendor,Catalog,Description,BinLocation',
      `JEST-VENDOR,${UPLOAD_PREFIX}DUPE,First row,A-1`,
      `JEST-VENDOR,${UPLOAD_PREFIX}DUPE,Second row,B-2`,
    ].join('\n');

    const res = await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    // Two CSV rows collapse to one part with two bins.
    expect(res.body.total).toBe(1);

    const [row] = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${UPLOAD_PREFIX + 'DUPE'}`);

    expect(row?.binLocations).toEqual(['A-1', 'B-2']);
  });

  it('never removes an existing bin when a re-upload omits it (additive merge)', async () => {
    // Seed the part with two bins. Bin cell is quoted because it contains
    // a comma (otherwise buildCsv's naive `,` join would split it).
    const seedCsv = [
      'Vendor,Catalog,Description,BinLocation',
      `JEST-VENDOR,${UPLOAD_PREFIX}KEEP,Original,"A-1, A-2"`,
    ].join('\n');
    await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv: seedCsv })
      .expect(200);

    // Re-upload the same part with one shared bin and one new bin.
    const updateCsv = [
      'Vendor,Catalog,Description,BinLocation',
      `JEST-VENDOR,${UPLOAD_PREFIX}KEEP,Updated,"A-2, A-3"`,
    ].join('\n');
    await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv: updateCsv })
      .expect(200);

    const [row] = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${UPLOAD_PREFIX + 'KEEP'}`);

    // A-1 (old, omitted) must still be present; A-2 deduped; A-3 added.
    expect(row?.binLocations).toEqual(['A-1', 'A-2', 'A-3']);
  });

  it('dedupes bins case-insensitively, preserving the first-seen casing', async () => {
    const csv = [
      'Vendor,Catalog,Description,BinLocation',
      `JEST-VENDOR,${UPLOAD_PREFIX}CASE,Case test,"a-1, A-1, A-2, a-2"`,
    ].join('\n');

    await supertest(app)
      .post('/api/admin/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ csv })
      .expect(200);

    const [row] = await db
      .select()
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = ${UPLOAD_PREFIX + 'CASE'}`);

    expect(row?.binLocations).toEqual(['a-1', 'A-2']);
  });
});
