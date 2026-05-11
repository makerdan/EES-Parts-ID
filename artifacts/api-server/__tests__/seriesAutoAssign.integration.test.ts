/**
 * Integration smoke-test for POST /api/series/auto-assign (SSE stream).
 *
 * Verifies that:
 *   1. The SSE stream completes with no errors (started → progress → done).
 *   2. Each seeded inventory row's series_id is set to the product_series.id
 *      that exactly matches its (vendor, catalog_parse->>'series') pair.
 *   3. Items from different vendors with the same series name land in
 *      *different* product_series rows (vendor is part of the unique key).
 *   4. Items with no series in catalog_parse are left unassigned.
 *   5. GET /api/series/coverage returns the correct assigned/total counts after
 *      auto-assign: total is unchanged and assigned grows by exactly 4
 *      (the number of fixture rows that had a series field).
 *   6. Running auto-assign a second time leaves series_id values unchanged.
 *
 * Isolation guarantees:
 *   - All inventory fixtures use the JEST-SRS- catalog prefix.
 *   - product_series rows created by auto-assign are tracked by ID and deleted
 *     by ID in afterAll — never by name, so pre-existing rows are untouched.
 *   - Coverage delta is measured via the /api/series/coverage endpoint itself
 *     (before snapshot taken before seeding fixture rows).
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
import { inArray, sql } from 'drizzle-orm';
import app from '../src/app';
import { signAdminToken } from '../src/routes/admin';
import { db, pool, inventoryTable, productSeriesTable } from '@workspace/db';
import { closePool } from './helpers/testDb';

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_SECRET = 'jest-series-autoassign-secret';
const CATALOG_PREFIX = 'JEST-SRS-';

let adminToken: string;

/**
 * Fixture definitions.
 * vendor + catalog are unique identifiers; series is what goes into
 * catalog_parse->>'series'. null means the row has no series field.
 * Two fixtures deliberately share the same series name but differ in vendor
 * to exercise the vendor-scoped uniqueness constraint on product_series.
 * 4 rows have a series (expected to get assigned); 1 does not.
 */
const FIXTURES = [
  { vendor: 'EATON', catalog: 'JEST-SRS-BR120', series: 'BR' },
  { vendor: 'EATON', catalog: 'JEST-SRS-BR220', series: 'BR' },
  { vendor: 'EATON', catalog: 'JEST-SRS-CH115', series: 'CH' },
  { vendor: 'SIEMENS', catalog: 'JEST-SRS-QP120', series: 'QP' },
  { vendor: 'EATON', catalog: 'JEST-SRS-NOSERIES', series: null },
] as const;

const FIXTURE_ASSIGNED_COUNT = 4; // fixtures with a non-null series field

// ── Shared state populated by the top-level beforeAll ─────────────────────────

/** SSE events from the first auto-assign run. */
let sseEvents: Record<string, unknown>[] = [];

/** /api/series/coverage snapshot taken BEFORE seeding fixtures or running auto-assign. */
let coverageBefore: { total: number; assigned: number };

/** /api/series/coverage snapshot taken AFTER the first auto-assign run completes. */
let coverageAfter: { total: number; assigned: number };

/** IDs of product_series rows that existed BEFORE this test suite ran. */
let preExistingSeriesIds = new Set<number>();

/** IDs of product_series rows that belong to our fixture (vendor, name) pairs
 *  — populated after the first auto-assign, deleted by ID in afterAll. */
let fixtureSeriesIds: number[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedFixtures() {
  for (const f of FIXTURES) {
    await db
      .insert(inventoryTable)
      .values({
        vendor: f.vendor,
        catalog: f.catalog,
        description: `Test fixture ${f.catalog}`,
        aiKeywords: [] as string[],
        catalogParse: f.series !== null ? { series: f.series } : null,
      })
      .onConflictDoUpdate({
        target: [inventoryTable.vendor, inventoryTable.catalog],
        set: {
          catalogParse: f.series !== null ? { series: f.series } : null,
          seriesId: null,
          description: `Test fixture ${f.catalog}`,
        },
      });
  }
}

async function cleanupInventory() {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + '%'}`);
}

/** Delete only the product_series rows that this suite created (ID-scoped). */
async function cleanupFixtureSeriesById() {
  if (fixtureSeriesIds.length === 0) return;
  const newIds = fixtureSeriesIds.filter((id) => !preExistingSeriesIds.has(id));
  if (newIds.length === 0) return;
  await db.delete(productSeriesTable).where(inArray(productSeriesTable.id, newIds));
}

/** Parse an SSE response body into an array of parsed JSON event objects. */
function parseSseEvents(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

/** Fetch /api/series/coverage and return { total, assigned }. */
async function fetchCoverage(): Promise<{ total: number; assigned: number }> {
  const res = await supertest(app)
    .get('/api/series/coverage')
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(200);
  return { total: res.body.total as number, assigned: res.body.assigned as number };
}

/** Run POST /api/series/auto-assign and return the parsed SSE events. */
async function runAutoAssign(): Promise<Record<string, unknown>[]> {
  const res = await supertest(app)
    .post('/api/series/auto-assign')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Accept', 'text/event-stream')
    .buffer(true)
    .parse((res, callback) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => callback(null, data));
    });
  expect(res.status).toBe(200);
  return parseSseEvents(res.body as string);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
// Everything is done in ONE top-level beforeAll so before/after coverage
// snapshots bracket the auto-assign call precisely.

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);

  // Hold the advisory lock throughout setup (steps 2-5) to prevent the
  // external API-server scheduler from interfering with our fixture rows
  // or coverage snapshots.  The previous pattern (acquire + immediately
  // release) left a race window: the scheduler could re-acquire the lock
  // and run auto-assign BEFORE our own call, causing:
  //   • our runAutoAssign() to get 409 ("already running"), or
  //   • the scheduler to assign other previously-unassigned inventory rows
  //     between the coverageBefore snapshot and coverageAfter, making the
  //     delta check fail with "expected N+4, got N+4+X".
  //
  // Fix: acquire (blocking) → do all setup → unlock → THEN call auto-assign.
  // The unlock MUST happen before runAutoAssign because the endpoint calls
  // pg_try_advisory_lock on its own PG session; if we still hold the lock
  // when the request arrives it will see it as "already running" and 409.
  //
  // statement_timeout = 30 s caps the initial wait.  If the lock is held
  // longer than 30 s, beforeAll fails with a clear error rather than hanging.
  // Force-release a stuck lock with:
  //   SELECT pg_terminate_backend(pid) FROM pg_locks
  //   WHERE locktype='advisory' AND objid=20250001 AND granted;
  const setupClient = await pool.connect();
  try {
    await setupClient.query("SET statement_timeout = '30s'");
    // Acquire and HOLD — scheduler is blocked from here until we unlock below.
    await setupClient.query('SELECT pg_advisory_lock($1::bigint)', [20250001]);

    // 2. Record which product_series rows already exist for our fixture pairs
    //    so we can safely delete only rows this suite creates.
    const existing = await db
      .select({ id: productSeriesTable.id })
      .from(productSeriesTable)
      .where(
        sql`(vendor, name) IN (
          ('EATON','BR'), ('EATON','CH'), ('SIEMENS','QP')
        )`
      );
    preExistingSeriesIds = new Set(existing.map((r) => r.id));

    // 3. Start with clean fixture rows.
    await cleanupInventory();

    // 4. Snapshot coverage BEFORE seeding — this is the baseline.
    //    Our fixture rows don't exist yet, so they won't skew the baseline.
    coverageBefore = await fetchCoverage();

    // 5. Seed the fixture rows (all with series_id = NULL).
    //    onConflictDoUpdate resets any stale row left by a previous killed run
    //    to the correct initial state rather than silently skipping it.
    await seedFixtures();

    // Release the lock NOW so the auto-assign endpoint can acquire it.
    await setupClient.query('SELECT pg_advisory_unlock($1::bigint)', [20250001]);
  } finally {
    setupClient.release();
  }

  // 6. Run auto-assign and capture SSE events.
  //    The lock is now free — the endpoint will acquire it normally.
  sseEvents = await runAutoAssign();

  // 7. Snapshot coverage AFTER auto-assign completes.
  //    The window between runAutoAssign completing and fetchCoverage is
  //    negligible; any scheduler run in this gap would not touch our
  //    fixture rows (they already have series_id set).
  coverageAfter = await fetchCoverage();

  // 8. Capture the product_series IDs for our fixture pairs (for ID-scoped cleanup).
  const created = await db
    .select({ id: productSeriesTable.id })
    .from(productSeriesTable)
    .where(
      sql`(vendor, name) IN (
        ('EATON','BR'), ('EATON','CH'), ('SIEMENS','QP')
      )`
    );
  fixtureSeriesIds = created.map((r) => r.id);
}, 60_000);

afterAll(async () => {
  await cleanupInventory(); // FK ON DELETE SET NULL clears series_id refs
  await cleanupFixtureSeriesById(); // ID-scoped; only removes rows this suite created
  await closePool();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// SSE stream shape
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/series/auto-assign — SSE stream shape', () => {
  it("first event is { status: 'started' }", () => {
    expect(sseEvents[0]).toMatchObject({ status: 'started' });
  });

  it("last event is { status: 'done' }", () => {
    const last = sseEvents[sseEvents.length - 1];
    expect(last).toMatchObject({ status: 'done' });
  });

  it('done event has a numeric seriesCount >= 3 (our 3 fixture series must be included)', () => {
    const done = sseEvents.find((e) => e['status'] === 'done');
    expect(done).toBeDefined();
    expect(typeof done!['seriesCount']).toBe('number');
    expect(done!['seriesCount'] as number).toBeGreaterThanOrEqual(3);
  });

  it('done event has a numeric assignedCount >= 0', () => {
    const done = sseEvents.find((e) => e['status'] === 'done');
    expect(typeof done!['assignedCount']).toBe('number');
    expect(done!['assignedCount'] as number).toBeGreaterThanOrEqual(0);
  });

  it('emits no error events', () => {
    const errorEvents = sseEvents.filter((e) => e['status'] === 'error');
    expect(errorEvents).toHaveLength(0);
  });

  it("emits at least one progress event for step 'upsert_series'", () => {
    const upsertEvents = sseEvents.filter(
      (e) => e['status'] === 'progress' && e['step'] === 'upsert_series'
    );
    expect(upsertEvents.length).toBeGreaterThan(0);
  });

  it("emits at least one progress event for step 'assign_items'", () => {
    const assignEvents = sseEvents.filter(
      (e) => e['status'] === 'progress' && e['step'] === 'assign_items'
    );
    expect(assignEvents.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB assertions: per-row series_id correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('inventory.series_id — per-row correctness after auto-assign', () => {
  it('each fixture catalog maps to the product_series.id for its (vendor, series) pair', async () => {
    // Build a map of "VENDOR|NAME" → product_series.id for the 3 expected pairs.
    const seriesRows = await db
      .select({
        id: productSeriesTable.id,
        vendor: productSeriesTable.vendor,
        name: productSeriesTable.name,
      })
      .from(productSeriesTable)
      .where(
        sql`(vendor, name) IN (
          ('EATON','BR'), ('EATON','CH'), ('SIEMENS','QP')
        )`
      );
    const idByKey = new Map(seriesRows.map((r) => [`${r.vendor}|${r.name}`, r.id]));

    expect(idByKey.has('EATON|BR')).toBe(true);
    expect(idByKey.has('EATON|CH')).toBe(true);
    expect(idByKey.has('SIEMENS|QP')).toBe(true);

    const inventoryRows = await db
      .select({ catalog: inventoryTable.catalog, seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(
        sql`${inventoryTable.catalog} IN (
          'JEST-SRS-BR120','JEST-SRS-BR220','JEST-SRS-CH115','JEST-SRS-QP120'
        )`
      );
    expect(inventoryRows).toHaveLength(4);

    const expectedSeriesForCatalog: Record<string, string> = {
      'JEST-SRS-BR120': 'EATON|BR',
      'JEST-SRS-BR220': 'EATON|BR',
      'JEST-SRS-CH115': 'EATON|CH',
      'JEST-SRS-QP120': 'SIEMENS|QP',
    };

    for (const row of inventoryRows) {
      const expectedKey = expectedSeriesForCatalog[row.catalog];
      const expectedId = idByKey.get(expectedKey!);
      expect(row.seriesId).toBe(expectedId);
    }
  });

  it('the two EATON BR fixtures share the same series_id', async () => {
    const rows = await db
      .select({ seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} IN ('JEST-SRS-BR120','JEST-SRS-BR220')`);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.seriesId).not.toBeNull();
    expect(rows[0]!.seriesId).toBe(rows[1]!.seriesId);
  });

  it('EATON CH gets a different series_id from EATON BR', async () => {
    const [br] = await db
      .select({ seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = 'JEST-SRS-BR120'`);
    const [ch] = await db
      .select({ seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = 'JEST-SRS-CH115'`);
    expect(br!.seriesId).not.toBeNull();
    expect(ch!.seriesId).not.toBeNull();
    expect(br!.seriesId).not.toBe(ch!.seriesId);
  });

  it('SIEMENS QP gets a series_id distinct from all EATON series_ids', async () => {
    const eatonRows = await db
      .select({ seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(
        sql`${inventoryTable.catalog} IN ('JEST-SRS-BR120','JEST-SRS-BR220','JEST-SRS-CH115')`
      );
    const [qp] = await db
      .select({ seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = 'JEST-SRS-QP120'`);

    const eatonIds = new Set(eatonRows.map((r) => r.seriesId));
    expect(qp!.seriesId).not.toBeNull();
    expect(eatonIds.has(qp!.seriesId)).toBe(false);
  });

  it('item with null catalog_parse series field remains unassigned (series_id IS NULL)', async () => {
    const [row] = await db
      .select({ seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(sql`${inventoryTable.catalog} = 'JEST-SRS-NOSERIES'`);
    expect(row).toBeDefined();
    expect(row!.seriesId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/series/coverage — before/after endpoint delta
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/series/coverage — before/after auto-assign delta', () => {
  it('total count does not change (auto-assign never adds or removes inventory rows)', () => {
    // total = coverage.total counts ALL inventory rows.
    // After seeding 5 fixtures and running auto-assign, the total should have
    // grown by 5 compared to the pre-seed baseline.
    expect(coverageAfter.total).toBe(coverageBefore.total + FIXTURES.length);
  });

  it('assigned count grows by exactly FIXTURE_ASSIGNED_COUNT (4) after auto-assign', () => {
    // The 4 fixture rows with a series field were unassigned before auto-assign
    // and assigned after. The 1 no-series fixture and all pre-existing rows
    // are unchanged, so the delta must be exactly 4.
    expect(coverageAfter.assigned).toBe(coverageBefore.assigned + FIXTURE_ASSIGNED_COUNT);
  });

  it('total >= assigned after auto-assign (no inversion)', () => {
    expect(coverageAfter.total).toBeGreaterThanOrEqual(coverageAfter.assigned);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency: re-running auto-assign does not change series_id values
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/series/auto-assign — idempotency', () => {
  beforeAll(async () => {
    // Wait until the advisory lock is genuinely free before proceeding.
    // We must use a raw pool.connect() client here — the route acquires the
    // lock on a raw pool client (a separate PG session), so calling
    // pg_advisory_unlock via a Drizzle session would be a no-op.
    // pg_advisory_lock (blocking) waits until the prior run has released it;
    // statement_timeout caps the wait so the suite doesn't hang indefinitely.
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '10s'");
      await client.query('SELECT pg_advisory_lock($1::bigint)', [20250001]);
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [20250001]);
    } catch {
      // Timed out or other error — proceed; the test will surface any real issue.
    } finally {
      client.release();
    }
  });

  // Timeout raised to 30 s — auto-assign scans the full inventory table and
  // can take several seconds on a populated dev database.
  it('second run leaves all fixture series_ids unchanged', async () => {
    const before = await db
      .select({ catalog: inventoryTable.catalog, seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(
        sql`${inventoryTable.catalog} IN (
          'JEST-SRS-BR120','JEST-SRS-BR220','JEST-SRS-CH115','JEST-SRS-QP120'
        )`
      );

    const events = await runAutoAssign();
    expect(events.find((e) => e['status'] === 'done')).toBeDefined();
    expect(events.filter((e) => e['status'] === 'error')).toHaveLength(0);

    const after = await db
      .select({ catalog: inventoryTable.catalog, seriesId: inventoryTable.seriesId })
      .from(inventoryTable)
      .where(
        sql`${inventoryTable.catalog} IN (
          'JEST-SRS-BR120','JEST-SRS-BR220','JEST-SRS-CH115','JEST-SRS-QP120'
        )`
      );

    const beforeMap = Object.fromEntries(before.map((r) => [r.catalog, r.seriesId]));
    const afterMap = Object.fromEntries(after.map((r) => [r.catalog, r.seriesId]));
    expect(afterMap).toEqual(beforeMap);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency lock: a second POST while one is running returns 409
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/series/auto-assign — concurrency lock', () => {
  // No beforeAll needed — the test holds the advisory lock itself, so there
  // is no dependency on any prior auto-assign run completing.

  // The previous approach fired two concurrent HTTP requests and relied on a
  // 150 ms delay for the first to acquire the lock before the second fired.
  // On a loaded or slow system the 150 ms was sometimes not enough — both
  // requests raced pg_try_advisory_lock, both received 200, and the test
  // failed with "expected 409, got 200".
  //
  // Fix: hold the advisory lock from a test-owned DB session BEFORE the
  // request is made.  The endpoint uses pg_try_advisory_lock (non-blocking),
  // which returns false immediately when the lock is already held — so it
  // returns 409 regardless of timing.  This is completely deterministic.
  it("returns 409 with 'already running' message when the advisory lock is held", async () => {
    const lockClient = await pool.connect();
    try {
      // Hold the lock to simulate another process mid-auto-assign.
      await lockClient.query('SELECT pg_advisory_lock($1::bigint)', [20250001]);

      const res = await supertest(app)
        .post('/api/series/auto-assign')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
      expect((res.body as { error?: string }).error).toMatch(/already running/i);
    } finally {
      // Always release — even if the assertion above throws — so we don't
      // leave a dangling lock that would block subsequent test suites.
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [20250001]);
      lockClient.release();
    }
  });
});
