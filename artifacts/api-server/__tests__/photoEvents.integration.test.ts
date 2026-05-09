/**
 * Integration tests for GET /api/photo/events.
 *
 * Uses a real PostgreSQL database (DATABASE_URL env var).
 * OpenAI integration is mocked to avoid requiring a live API key.
 *
 * The photo_id_event table is telemetry / analytics only — no FKs
 * constrain it from the outside — so beforeAll truncates it to give
 * the paginated query a clean, deterministic baseline.
 *
 * Dataset (8 rows total):
 *   Rows 1-7 are "recent" (ts ≈ now).
 *   Row 8 is "old" (ts = now − 2 h) to test window filtering.
 *
 *   row 1  parseOk=true  catalog_exact    topResult=invA confirmed=invA latency=100 visionRaw={raw:'scan text A'}
 *   row 2  parseOk=true  catalog_exact    topResult=invB confirmed=invB latency=200 visionRaw={catalogNumber:'B2'}
 *   row 3  parseOk=true  attribute_match  topResult=invA confirmed=null  latency=300
 *   row 4  parseOk=true  attribute_match  topResult=null confirmed=null  latency=400
 *   row 5  parseOk=true  descriptive      topResult=null confirmed=null  latency=500
 *   row 6  parseOk=false null             topResult=null confirmed=null  latency=600 visionRaw={raw:'garbled text'}
 *   row 7  parseOk=false null             topResult=null confirmed=null  latency=700
 *   row 8  parseOk=true  catalog_exact    topResult=null confirmed=null  latency=800 (2 h ago — outside 1-hour window)
 *
 * Filter expectations (default 24-h window = all 8 rows):
 *   parseOk=true  → rows 1-5, 8  = 6 rows total
 *   parseOk=false → rows 6-7     = 2 rows total
 *   matchType=catalog_exact   → rows 1,2,8 = 3
 *   matchType=attribute_match → rows 3,4   = 2
 *   matchType=descriptive     → row 5      = 1
 *   confirmed=yes → rows 1,2  = 2
 *   confirmed=no  → rows 3-8  = 6
 *   windowHours=0 (clamped to 1) → rows 1-7 only (row 8 excluded) = 7
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
import { sql } from 'drizzle-orm';
import app from '../src/app';
import { signAdminToken } from '../src/routes/admin';
import { db, pool, inventoryTable, photoIdEventTable } from '@workspace/db';

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_SECRET = 'jest-photo-events-secret';
const CATALOG_PREFIX = 'JEST-ITG-EVT-';
const IMAGE_HASH_PREFIX = 'JEST-ITG-EVT-';

let adminToken: string;
let invAId: number;
let invBId: number;

// Response captured right after truncation (before any events are seeded).
let emptyBody: Record<string, unknown>;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertInventoryItem(catalog: string): Promise<number> {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: 'JEST-EVT-VENDOR',
      catalog,
      description: `Photo events test item ${catalog}`,
      binLocations: [],
      aiKeywords: [] as string[],
    })
    .onConflictDoNothing()
    .returning({ id: inventoryTable.id });
  return row!.id;
}

async function cleanupTestInventory() {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + '%'}`);
}

async function cleanupTestEvents() {
  await db
    .delete(photoIdEventTable)
    .where(sql`${photoIdEventTable.imageHash} LIKE ${IMAGE_HASH_PREFIX + '%'}`);
}

function authedGet(path: string) {
  return supertest(app).get(path).set('Authorization', `Bearer ${adminToken}`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);

  // Clean up any fixture leftovers from a previous interrupted run.
  await cleanupTestEvents();
  await cleanupTestInventory();

  // Truncate telemetry table for a deterministic baseline.
  // photo_id_event is analytics-only; no FK references constrain it.
  await db.execute(sql`TRUNCATE TABLE photo_id_event RESTART IDENTITY`);

  // ── Capture empty-table baseline ───────────────────────────────────────────
  const emptyRes = await authedGet('/api/photo/events').expect(200);
  emptyBody = emptyRes.body as Record<string, unknown>;

  // ── Seed inventory items (needed for top/confirmed result JOIN) ─────────────
  invAId = await insertInventoryItem(`${CATALOG_PREFIX}A`);
  invBId = await insertInventoryItem(`${CATALOG_PREFIX}B`);

  // ── Seed photo_id_event rows ───────────────────────────────────────────────
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  await db.insert(photoIdEventTable).values([
    // row 1 — catalog_exact, parseOk, confirmed=invA, has visionRaw with 'raw' key
    {
      imageHash: `${IMAGE_HASH_PREFIX}01`,
      parseOk: true,
      catalogGuess: 'CATG-A1',
      vendorGuess: 'EATON',
      matchType: 'catalog_exact',
      topResultId: invAId,
      confirmedResultId: invAId,
      latencyMs: 100,
      visionRaw: { raw: 'catalog_number: CATG-A1, vendor: EATON' } as unknown as Record<
        string,
        unknown
      >,
      ts: now,
    },
    // row 2 — catalog_exact, parseOk, confirmed=invB, has visionRaw with parsed object key
    {
      imageHash: `${IMAGE_HASH_PREFIX}02`,
      parseOk: true,
      catalogGuess: 'CATG-B2',
      vendorGuess: 'SIEMENS',
      matchType: 'catalog_exact',
      topResultId: invBId,
      confirmedResultId: invBId,
      latencyMs: 200,
      visionRaw: { catalogNumber: 'CATG-B2', vendorName: 'SIEMENS' } as unknown as Record<
        string,
        unknown
      >,
      ts: now,
    },
    // row 3 — attribute_match, parseOk, top=invA, no confirm
    {
      imageHash: `${IMAGE_HASH_PREFIX}03`,
      parseOk: true,
      catalogGuess: 'CATG-A3',
      vendorGuess: null,
      matchType: 'attribute_match',
      topResultId: invAId,
      confirmedResultId: null,
      latencyMs: 300,
      ts: now,
    },
    // row 4 — attribute_match, parseOk, no top/confirm
    {
      imageHash: `${IMAGE_HASH_PREFIX}04`,
      parseOk: true,
      catalogGuess: null,
      vendorGuess: null,
      matchType: 'attribute_match',
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 400,
      ts: now,
    },
    // row 5 — descriptive, parseOk, no top/confirm
    {
      imageHash: `${IMAGE_HASH_PREFIX}05`,
      parseOk: true,
      catalogGuess: null,
      vendorGuess: null,
      matchType: 'descriptive',
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 500,
      ts: now,
    },
    // row 6 — parse failed, has visionRaw with 'raw' key (garbled text)
    {
      imageHash: `${IMAGE_HASH_PREFIX}06`,
      parseOk: false,
      catalogGuess: null,
      vendorGuess: null,
      matchType: null,
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 600,
      visionRaw: { raw: 'garbled AI response text that failed to parse' } as unknown as Record<
        string,
        unknown
      >,
      ts: now,
    },
    // row 7 — parse failed, no visionRaw
    {
      imageHash: `${IMAGE_HASH_PREFIX}07`,
      parseOk: false,
      catalogGuess: null,
      vendorGuess: null,
      matchType: null,
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 700,
      ts: now,
    },
    // row 8 — "old" event 2 h ago: parseOk, catalog_exact, no top/confirm
    //         Included in the 24-h window, excluded from the 1-h window.
    {
      imageHash: `${IMAGE_HASH_PREFIX}OLD`,
      parseOk: true,
      catalogGuess: 'CATG-OLD',
      vendorGuess: null,
      matchType: 'catalog_exact',
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 800,
      ts: twoHoursAgo,
    },
  ]);
}, 30_000);

afterAll(async () => {
  await cleanupTestEvents();
  await cleanupTestInventory();
  await pool.end();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// 401 — endpoint requires a valid admin token
// ─────────────────────────────────────────────────────────────────────────────

describe('Authentication — GET /api/photo/events requires a valid admin token', () => {
  it('returns 401 with no Authorization header', async () => {
    await supertest(app).get('/api/photo/events').expect(401);
  });

  it('returns 401 with a malformed Bearer token', async () => {
    await supertest(app)
      .get('/api/photo/events')
      .set('Authorization', 'Bearer totally-invalid-token')
      .expect(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty table — captured before seeding
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — empty table baseline', () => {
  it('returns 200 with the expected response shape', () => {
    expect(emptyBody).toHaveProperty('items');
    expect(emptyBody).toHaveProperty('total');
    expect(emptyBody).toHaveProperty('page');
    expect(emptyBody).toHaveProperty('limit');
  });

  it('items is an empty array', () => {
    expect(Array.isArray(emptyBody.items)).toBe(true);
    expect((emptyBody.items as unknown[]).length).toBe(0);
  });

  it('total = 0', () => {
    expect(emptyBody.total).toBe(0);
  });

  it('page = 1 (default)', () => {
    expect(emptyBody.page).toBe(1);
  });

  it('limit = 20 (default)', () => {
    expect(emptyBody.limit).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// windowHours clamping
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — windowHours clamping', () => {
  it('clamps 0 up to 1 and echoes limit default', async () => {
    const res = await authedGet('/api/photo/events?windowHours=0').expect(200);
    // windowHours itself is not echoed but we can verify the total is 7 (1-h window)
    expect((res.body as { total: number }).total).toBe(7);
  });

  it('clamps 99999 down to 720 (returns all 8 rows — all within 30d)', async () => {
    const res = await authedGet('/api/photo/events?windowHours=99999').expect(200);
    expect((res.body as { total: number }).total).toBe(8);
  });

  it('defaults to 24 h when windowHours is omitted (returns all 8 rows)', async () => {
    const res = await authedGet('/api/photo/events').expect(200);
    expect((res.body as { total: number }).total).toBe(8);
  });

  it('passes through an in-range value (windowHours=48, all 8 rows within 48 h)', async () => {
    const res = await authedGet('/api/photo/events?windowHours=48').expect(200);
    expect((res.body as { total: number }).total).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Window filtering — 1-h window excludes the 2-hour-old row
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — window filtering (windowHours=0 → 1)', () => {
  let body: { items: Record<string, unknown>[]; total: number; page: number; limit: number };

  beforeAll(async () => {
    const res = await authedGet('/api/photo/events?windowHours=0').expect(200);
    body = res.body as typeof body;
  });

  it('total = 7 (the 2-hour-old row falls outside the 1-hour window)', () => {
    expect(body.total).toBe(7);
  });

  it('none of the returned items have the OLD image hash', () => {
    for (const item of body.items) {
      expect(item['imageHash']).not.toBe(`${IMAGE_HASH_PREFIX}OLD`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — full 24-hour window, unfiltered
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — happy path (all 8 rows, 24-h window)', () => {
  let body: {
    items: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
  };

  beforeAll(async () => {
    const res = await authedGet('/api/photo/events').expect(200);
    body = res.body as typeof body;
  });

  it('total = 8', () => {
    expect(body.total).toBe(8);
  });

  it('returns page=1 limit=20 by default', () => {
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  it('items has exactly 8 entries (all fit in one page)', () => {
    expect(body.items.length).toBe(8);
  });

  it('items are ordered newest-first (ts DESC)', () => {
    // The OLD row (2 h ago) must appear last among the returned items.
    const last = body.items[body.items.length - 1]!;
    expect(last['imageHash']).toBe(`${IMAGE_HASH_PREFIX}OLD`);
  });

  it('each item has the required fields', () => {
    for (const item of body.items) {
      expect(typeof item['id']).toBe('number');
      expect(typeof item['ts']).toBe('string');
      expect(typeof item['parseOk']).toBe('boolean');
    }
  });

  it('confirmed rows carry topResultCatalog and topResultVendor from inventory JOIN', () => {
    // row 1: topResultId = invAId → catalog = JEST-ITG-EVT-A, vendor = JEST-EVT-VENDOR
    const row1 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}01`);
    expect(row1).toBeDefined();
    expect(row1!['topResultCatalog']).toBe(`${CATALOG_PREFIX}A`);
    expect(row1!['topResultVendor']).toBe('JEST-EVT-VENDOR');
  });

  it('confirmed rows carry confirmedResultCatalog and confirmedResultVendor', () => {
    const row1 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}01`);
    expect(row1!['confirmedResultCatalog']).toBe(`${CATALOG_PREFIX}A`);
    expect(row1!['confirmedResultVendor']).toBe('JEST-EVT-VENDOR');
  });

  it('unconfirmed rows have null confirmedResult fields', () => {
    const row3 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}03`);
    expect(row3!['confirmedResultCatalog']).toBeNull();
    expect(row3!['confirmedResultVendor']).toBeNull();
  });

  it('catalogGuess and vendorGuess are returned when set', () => {
    const row1 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}01`);
    expect(row1!['catalogGuess']).toBe('CATG-A1');
    expect(row1!['vendorGuess']).toBe('EATON');
  });

  it('catalogGuess and vendorGuess are null when not set', () => {
    const row4 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}04`);
    expect(row4!['catalogGuess']).toBeNull();
    expect(row4!['vendorGuess']).toBeNull();
  });

  it('latencyMs is returned as a number', () => {
    const row1 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}01`);
    expect(row1!['latencyMs']).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// visionRawSummary — extracted from vision_raw JSONB
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — visionRawSummary field', () => {
  let body: { items: Record<string, unknown>[]; total: number };

  beforeAll(async () => {
    const res = await authedGet('/api/photo/events').expect(200);
    body = res.body as typeof body;
  });

  it("uses vision_raw->>'raw' when the 'raw' key exists (parse-failed row)", () => {
    // row 6 has visionRaw = { raw: 'garbled AI response text that failed to parse' }
    const row6 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}06`);
    expect(row6).toBeDefined();
    expect(row6!['visionRawSummary']).toBe('garbled AI response text that failed to parse');
  });

  it('falls back to JSON text excerpt when no raw key exists', () => {
    // row 2 has visionRaw = { catalogNumber: 'CATG-B2', vendorName: 'SIEMENS' }
    const row2 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}02`);
    expect(row2).toBeDefined();
    expect(typeof row2!['visionRawSummary']).toBe('string');
    expect((row2!['visionRawSummary'] as string).length).toBeGreaterThan(0);
  });

  it('is null when vision_raw is null', () => {
    // row 7 has no visionRaw inserted
    const row7 = body.items.find((i) => i['imageHash'] === `${IMAGE_HASH_PREFIX}07`);
    expect(row7).toBeDefined();
    expect(row7!['visionRawSummary']).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseOk filter
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — parseOk filter', () => {
  it('parseOk=true returns only parse-successful rows (6 of 8)', async () => {
    const res = await authedGet('/api/photo/events?parseOk=true').expect(200);
    const body = res.body as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(6);
    for (const item of body.items) {
      expect(item['parseOk']).toBe(true);
    }
  });

  it('parseOk=false returns only parse-failed rows (2 of 8)', async () => {
    const res = await authedGet('/api/photo/events?parseOk=false').expect(200);
    const body = res.body as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(2);
    for (const item of body.items) {
      expect(item['parseOk']).toBe(false);
    }
  });

  it('omitting parseOk returns all rows (no filter applied)', async () => {
    const res = await authedGet('/api/photo/events').expect(200);
    expect((res.body as { total: number }).total).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// matchType filter
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — matchType filter', () => {
  it('matchType=catalog_exact returns 3 rows (rows 1, 2, 8)', async () => {
    const res = await authedGet('/api/photo/events?matchType=catalog_exact').expect(200);
    const body = res.body as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(3);
    for (const item of body.items) {
      expect(item['matchType']).toBe('catalog_exact');
    }
  });

  it('matchType=attribute_match returns 2 rows (rows 3, 4)', async () => {
    const res = await authedGet('/api/photo/events?matchType=attribute_match').expect(200);
    const body = res.body as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(2);
    for (const item of body.items) {
      expect(item['matchType']).toBe('attribute_match');
    }
  });

  it('matchType=descriptive returns 1 row (row 5)', async () => {
    const res = await authedGet('/api/photo/events?matchType=descriptive').expect(200);
    const body = res.body as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!['matchType']).toBe('descriptive');
  });

  it('matchType=unknown_type returns 0 rows', async () => {
    const res = await authedGet('/api/photo/events?matchType=unknown_type').expect(200);
    const body = res.body as { items: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.items.length).toBe(0);
  });

  it('matchType + windowHours narrow results correctly (catalog_exact within 1 h = 2)', async () => {
    const res = await authedGet('/api/photo/events?matchType=catalog_exact&windowHours=1').expect(
      200
    );
    // Only rows 1 and 2 are recent catalog_exact (row 8 is 2 h old — outside 1-h window)
    expect((res.body as { total: number }).total).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// confirmed filter
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — confirmed filter', () => {
  it('confirmed=yes returns only events with a confirmedResultId (rows 1, 2)', async () => {
    const res = await authedGet('/api/photo/events?confirmed=yes').expect(200);
    const body = res.body as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(2);
    for (const item of body.items) {
      expect(item['confirmedResultCatalog']).not.toBeNull();
    }
  });

  it('confirmed=no returns only events without a confirmedResultId (rows 3-8 = 6)', async () => {
    const res = await authedGet('/api/photo/events?confirmed=no').expect(200);
    const body = res.body as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(6);
    for (const item of body.items) {
      expect(item['confirmedResultCatalog']).toBeNull();
    }
  });

  it('omitting confirmed returns all 8 rows', async () => {
    const res = await authedGet('/api/photo/events').expect(200);
    expect((res.body as { total: number }).total).toBe(8);
  });

  it('confirmed=yes combined with parseOk=true returns only parsed + confirmed rows', async () => {
    const res = await authedGet('/api/photo/events?confirmed=yes&parseOk=true').expect(200);
    const body = res.body as { items: Record<string, unknown>[]; total: number };
    // Both rows 1 and 2 are parseOk=true AND confirmed
    expect(body.total).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pagination — page, limit, total metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/events — pagination', () => {
  it('limit=3 returns at most 3 items but total stays at 8', async () => {
    const res = await authedGet('/api/photo/events?limit=3').expect(200);
    const body = res.body as { items: unknown[]; total: number; page: number; limit: number };
    expect(body.items.length).toBe(3);
    expect(body.total).toBe(8);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(3);
  });

  it('page=2 with limit=3 returns the next 3 items', async () => {
    const res = await authedGet('/api/photo/events?limit=3&page=2').expect(200);
    const body = res.body as { items: unknown[]; total: number; page: number };
    expect(body.items.length).toBe(3);
    expect(body.total).toBe(8);
    expect(body.page).toBe(2);
  });

  it('page=3 with limit=3 returns the remaining 2 items', async () => {
    const res = await authedGet('/api/photo/events?limit=3&page=3').expect(200);
    const body = res.body as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(8);
  });

  it('page beyond total returns 0 items but total is unchanged', async () => {
    const res = await authedGet('/api/photo/events?limit=20&page=99').expect(200);
    const body = res.body as { items: unknown[]; total: number; page: number };
    expect(body.items.length).toBe(0);
    expect(body.total).toBe(8);
    expect(body.page).toBe(99);
  });

  it('limit > 100 is clamped to 100', async () => {
    const res = await authedGet('/api/photo/events?limit=999').expect(200);
    const body = res.body as { limit: number };
    expect(body.limit).toBe(100);
  });

  it('limit < 1 is clamped to 1', async () => {
    const res = await authedGet('/api/photo/events?limit=0').expect(200);
    const body = res.body as { items: unknown[]; limit: number };
    expect(body.limit).toBe(1);
    expect(body.items.length).toBeLessThanOrEqual(1);
  });

  it('page < 1 is clamped to 1', async () => {
    const res = await authedGet('/api/photo/events?page=0').expect(200);
    expect((res.body as { page: number }).page).toBe(1);
  });

  it('page 1 and page 2 (limit=5) return distinct non-overlapping items', async () => {
    const [r1, r2] = await Promise.all([
      authedGet('/api/photo/events?limit=5&page=1').expect(200),
      authedGet('/api/photo/events?limit=5&page=2').expect(200),
    ]);
    const ids1 = (r1.body as { items: { id: number }[] }).items.map((i) => i.id);
    const ids2 = (r2.body as { items: { id: number }[] }).items.map((i) => i.id);
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap.length).toBe(0);
  });
});
