/**
 * Integration tests for GET /api/photo/stats.
 *
 * Uses a real PostgreSQL database (DATABASE_URL env var).
 * OpenAI integration is mocked to avoid requiring a live API key.
 *
 * The photo_id_event table is telemetry / analytics only — no FKs
 * constrain it from the outside — so beforeAll truncates it to give
 * the aggregation SQL a clean, deterministic baseline.  afterAll
 * re-deletes the fixture rows inserted during the suite.
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
const ADMIN_SECRET = 'jest-photo-stats-secret';
const CATALOG_PREFIX = 'JEST-ITG-PHOTO-';

let adminToken: string;
let invAId: number;
let invBId: number;
let invCId: number;

// Body captured right after truncation (before any events are seeded).
let emptyWindowBody: Record<string, unknown>;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertInventoryItem(catalog: string): Promise<number> {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: 'JEST-VENDOR',
      catalog,
      description: `Photo stats test item ${catalog}`,
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
    .where(sql`${photoIdEventTable.imageHash} LIKE ${'JEST-ITG-PHOTO-%'}`);
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

  // Truncate the telemetry table so aggregate assertions are exact.
  // photo_id_event is analytics-only; it has no FK references from other tables.
  await db.execute(sql`TRUNCATE TABLE photo_id_event RESTART IDENTITY`);

  // ── Capture empty-table baseline (real DB-backed, not mocked) ──────────────
  // This exercises the aggregation SQL on an empty table and confirms the handler
  // maps COUNT(*) = 0 / NULL latencies to the correct zero-value response shape.
  const emptyRes = await authedGet('/api/photo/stats').expect(200);
  emptyWindowBody = emptyRes.body as Record<string, unknown>;

  // Seed inventory items (needed for the top_parts CTE JOIN).
  invAId = await insertInventoryItem(`${CATALOG_PREFIX}A`);
  invBId = await insertInventoryItem(`${CATALOG_PREFIX}B`);
  invCId = await insertInventoryItem(`${CATALOG_PREFIX}C`);

  // ── Seed photo_id_event rows ───────────────────────────────────────────────
  //
  // "recent" events (ts = now()) fall inside any window >= 1 h.
  // "old"    event  (ts = now() − 2 h) falls outside a 1-hour window but
  //                  inside the default 24-hour window.
  //
  // Recent batch (8 rows):
  //   parseOk:            6 true  / 2 false
  //   with topResultId:   5 rows  (rows 1-5)
  //   confirmedResultId:  2 → invA (rows 1-2), 1 → invB (row 3)
  //   matchType:          3 catalog_exact, 2 attribute_match, 1 descriptive, 2 null
  //   latencyMs:          100, 200, 300, 400, 500, 600, 700, 800
  //
  // Old batch (1 row):
  //   parseOk: true, catalog_exact, no top/confirmed, latency 999
  //
  // Expected aggregates for the default 24-hour window (all 9 rows):
  //   totalScans       = 9
  //   parseOk          = 7  → parseSuccessRate = 7/9
  //   withTop          = 5
  //   confirmed        = 3  → confirmationRate  = 3/5 = 0.6
  //   catalogExact     = 4 (3 recent + 1 old)
  //   attributeMatch   = 2
  //   descriptive      = 1
  //   avgLatencyMs     = round((100+200+300+400+500+600+700+800+999)/9) = 511
  //   p95LatencyMs     = percentile_cont(0.95) over [100..999]
  //                      rank = 1 + 0.95*(9-1) = 8.6 → 800 + 0.6*(999-800) = 919
  //   topConfirmedParts[0] = { invAId, confirmedCount: 2 }
  //   topConfirmedParts[1] = { invBId, confirmedCount: 1 }
  //
  // For the 1-hour window (windowHours=0 clamped to 1):
  //   Only the 8 recent rows are included; the 2-hour-old row is excluded.

  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  await db.insert(photoIdEventTable).values([
    // row 1 — catalog_exact, parseOk, confirmed=invA, latency 100
    {
      imageHash: 'JEST-ITG-PHOTO-01',
      parseOk: true,
      matchType: 'catalog_exact',
      topResultId: invAId,
      confirmedResultId: invAId,
      latencyMs: 100,
      ts: now,
    },
    // row 2 — catalog_exact, parseOk, confirmed=invA, latency 200
    {
      imageHash: 'JEST-ITG-PHOTO-02',
      parseOk: true,
      matchType: 'catalog_exact',
      topResultId: invAId,
      confirmedResultId: invAId,
      latencyMs: 200,
      ts: now,
    },
    // row 3 — catalog_exact, parseOk, confirmed=invB, latency 300
    {
      imageHash: 'JEST-ITG-PHOTO-03',
      parseOk: true,
      matchType: 'catalog_exact',
      topResultId: invBId,
      confirmedResultId: invBId,
      latencyMs: 300,
      ts: now,
    },
    // row 4 — attribute_match, parseOk, top=invC, no confirm, latency 400
    {
      imageHash: 'JEST-ITG-PHOTO-04',
      parseOk: true,
      matchType: 'attribute_match',
      topResultId: invCId,
      confirmedResultId: null,
      latencyMs: 400,
      ts: now,
    },
    // row 5 — attribute_match, parseOk, top=invC, no confirm, latency 500
    {
      imageHash: 'JEST-ITG-PHOTO-05',
      parseOk: true,
      matchType: 'attribute_match',
      topResultId: invCId,
      confirmedResultId: null,
      latencyMs: 500,
      ts: now,
    },
    // row 6 — descriptive, parseOk, no top/confirm, latency 600
    {
      imageHash: 'JEST-ITG-PHOTO-06',
      parseOk: true,
      matchType: 'descriptive',
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 600,
      ts: now,
    },
    // row 7 — parse failed, no match, latency 700
    {
      imageHash: 'JEST-ITG-PHOTO-07',
      parseOk: false,
      matchType: null,
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 700,
      ts: now,
    },
    // row 8 — parse failed, no match, latency 800
    {
      imageHash: 'JEST-ITG-PHOTO-08',
      parseOk: false,
      matchType: null,
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 800,
      ts: now,
    },
    // row 9 — "old" event 2 h ago: parse ok, catalog_exact, no top/confirm, latency 999.
    //         Included in the 24-h window but excluded from the 1-h window.
    {
      imageHash: 'JEST-ITG-PHOTO-OLD',
      parseOk: true,
      matchType: 'catalog_exact',
      topResultId: null,
      confirmedResultId: null,
      latencyMs: 999,
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

describe('Authentication — GET /api/photo/stats requires a valid admin token', () => {
  it('returns 401 with no Authorization header', async () => {
    await supertest(app).get('/api/photo/stats').expect(401);
  });

  it('returns 401 with a bad token', async () => {
    await supertest(app)
      .get('/api/photo/stats')
      .set('Authorization', 'Bearer totally-invalid-token')
      .expect(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// windowHours clamping
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/stats — windowHours clamping', () => {
  it('clamps 0 up to 1 and echoes windowHours=1', async () => {
    const res = await authedGet('/api/photo/stats?windowHours=0').expect(200);
    expect(res.body.windowHours).toBe(1);
  });

  it('clamps 99999 down to 720 and echoes windowHours=720', async () => {
    const res = await authedGet('/api/photo/stats?windowHours=99999').expect(200);
    expect(res.body.windowHours).toBe(720);
  });

  it('defaults to windowHours=24 when the param is omitted', async () => {
    const res = await authedGet('/api/photo/stats').expect(200);
    expect(res.body.windowHours).toBe(24);
  });

  it('uses the supplied value when it is within range (e.g. 48)', async () => {
    const res = await authedGet('/api/photo/stats?windowHours=48').expect(200);
    expect(res.body.windowHours).toBe(48);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty table → zeros and nulls  (real DB-backed, not mocked)
//
// emptyWindowBody was captured in beforeAll immediately after truncation,
// before any events were inserted. This exercises the full SQL aggregation
// path on an empty table — not just the handler's post-processing logic.
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/stats — empty table returns zeros and nulls', () => {
  it('has the expected top-level shape', () => {
    expect(emptyWindowBody).toHaveProperty('windowHours');
    expect(emptyWindowBody).toHaveProperty('totalScans');
    expect(emptyWindowBody).toHaveProperty('parseSuccessRate');
    expect(emptyWindowBody).toHaveProperty('confirmationRate');
    expect(emptyWindowBody).toHaveProperty('matchTypeDistribution');
    expect(emptyWindowBody).toHaveProperty('avgLatencyMs');
    expect(emptyWindowBody).toHaveProperty('p95LatencyMs');
    expect(emptyWindowBody).toHaveProperty('topConfirmedParts');
  });

  it('totalScans = 0', () => {
    expect(emptyWindowBody.totalScans).toBe(0);
  });

  it('parseSuccessRate = 0', () => {
    expect(emptyWindowBody.parseSuccessRate).toBe(0);
  });

  it('confirmationRate = 0', () => {
    expect(emptyWindowBody.confirmationRate).toBe(0);
  });

  it('all match-type distribution counts = 0', () => {
    const dist = emptyWindowBody.matchTypeDistribution as Record<string, number>;
    expect(dist.catalogExact).toBe(0);
    expect(dist.attributeMatch).toBe(0);
    expect(dist.descriptive).toBe(0);
  });

  it('avgLatencyMs = null', () => {
    expect(emptyWindowBody.avgLatencyMs).toBeNull();
  });

  it('p95LatencyMs = null', () => {
    expect(emptyWindowBody.p95LatencyMs).toBeNull();
  });

  it('topConfirmedParts = []', () => {
    expect(Array.isArray(emptyWindowBody.topConfirmedParts)).toBe(true);
    expect((emptyWindowBody.topConfirmedParts as unknown[]).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Window filtering — windowHours=0 → 1 excludes the 2-hour-old event
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/stats — window filtering (windowHours=0 → 1)', () => {
  let body: Record<string, unknown>;

  beforeAll(async () => {
    const res = await authedGet('/api/photo/stats?windowHours=0').expect(200);
    body = res.body as Record<string, unknown>;
  });

  it('totalScans = 8 (the 2-hour-old row is outside the 1-hour window)', () => {
    expect(body.totalScans).toBe(8);
  });

  it('matchTypeDistribution.catalogExact = 3 (old catalog_exact row excluded)', () => {
    const dist = body.matchTypeDistribution as Record<string, number>;
    expect(dist.catalogExact).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seeded data — aggregate counts match expected values (24 h window = all 9 rows)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/stats — aggregate correctness (24 h window, all 9 rows)', () => {
  let body: Record<string, unknown>;

  beforeAll(async () => {
    const res = await authedGet('/api/photo/stats').expect(200);
    body = res.body as Record<string, unknown>;
  });

  it('response has the expected top-level shape', () => {
    expect(body).toHaveProperty('windowHours');
    expect(body).toHaveProperty('totalScans');
    expect(body).toHaveProperty('parseSuccessRate');
    expect(body).toHaveProperty('confirmationRate');
    expect(body).toHaveProperty('matchTypeDistribution');
    expect(body).toHaveProperty('avgLatencyMs');
    expect(body).toHaveProperty('p95LatencyMs');
    expect(body).toHaveProperty('topConfirmedParts');
  });

  it('totalScans = 9 (8 recent + 1 old)', () => {
    expect(body.totalScans).toBe(9);
  });

  it('parseSuccessRate = 7/9 (6 recent parseOk + 1 old parseOk)', () => {
    expect(typeof body.parseSuccessRate).toBe('number');
    expect(body.parseSuccessRate as number).toBeCloseTo(7 / 9, 5);
  });

  it('confirmationRate = 3/5 (3 confirmed out of 5 rows that have a topResultId)', () => {
    expect(typeof body.confirmationRate).toBe('number');
    expect(body.confirmationRate as number).toBeCloseTo(3 / 5, 5);
  });

  it('matchTypeDistribution.catalogExact = 4 (3 recent + 1 old)', () => {
    const dist = body.matchTypeDistribution as Record<string, number>;
    expect(dist.catalogExact).toBe(4);
  });

  it('matchTypeDistribution.attributeMatch = 2', () => {
    const dist = body.matchTypeDistribution as Record<string, number>;
    expect(dist.attributeMatch).toBe(2);
  });

  it('matchTypeDistribution.descriptive = 1', () => {
    const dist = body.matchTypeDistribution as Record<string, number>;
    expect(dist.descriptive).toBe(1);
  });

  it('avgLatencyMs = 511 — integer average of (100+200+300+400+500+600+700+800+999)/9', () => {
    // (100+200+300+400+500+600+700+800+999) = 4599 / 9 ≈ 511.0 → cast to int = 511
    expect(body.avgLatencyMs).toBe(511);
  });

  it('p95LatencyMs = 919 — PostgreSQL percentile_cont(0.95) interpolation', () => {
    // rank = 1 + 0.95*(9-1) = 8.6 → sorted[7]=800, sorted[8]=999
    //      = 800 + 0.6*(999-800) = 919 (cast ::int → 919)
    expect(body.p95LatencyMs).toBe(919);
  });

  it('topConfirmedParts has invA first with confirmedCount=2', () => {
    const top = body.topConfirmedParts as Array<{
      inventoryId: number;
      catalog: string;
      vendor: string;
      confirmedCount: number;
    }>;
    expect(Array.isArray(top)).toBe(true);
    expect(top.length).toBeGreaterThanOrEqual(2);

    const first = top[0]!;
    expect(first.inventoryId).toBe(invAId);
    expect(first.confirmedCount).toBe(2);
    expect(first.catalog).toBe(`${CATALOG_PREFIX}A`);
    expect(first.vendor).toBe('JEST-VENDOR');
  });

  it('topConfirmedParts has invB second with confirmedCount=1', () => {
    const top = body.topConfirmedParts as Array<{
      inventoryId: number;
      confirmedCount: number;
    }>;
    const second = top[1]!;
    expect(second.inventoryId).toBe(invBId);
    expect(second.confirmedCount).toBe(1);
  });

  it('topConfirmedParts items have the expected shape', () => {
    const top = body.topConfirmedParts as Array<Record<string, unknown>>;
    for (const item of top) {
      expect(typeof item['inventoryId']).toBe('number');
      expect(typeof item['catalog']).toBe('string');
      expect(typeof item['vendor']).toBe('string');
      expect(typeof item['confirmedCount']).toBe('number');
    }
  });

  it('invC does not appear in topConfirmedParts (no confirmedResultId — only topResultId)', () => {
    const top = body.topConfirmedParts as Array<{ inventoryId: number }>;
    expect(top.every((t) => t.inventoryId !== invCId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-CTE design — handler must issue exactly one DB round-trip per request
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/photo/stats — single DB call (CTE design)', () => {
  it('calls db.execute exactly once per request', async () => {
    const executeSpy = jest.spyOn(db, 'execute');

    await authedGet('/api/photo/stats').expect(200);

    const callCount = executeSpy.mock.calls.length;
    executeSpy.mockRestore();

    expect(callCount).toBe(1);
  });
});
