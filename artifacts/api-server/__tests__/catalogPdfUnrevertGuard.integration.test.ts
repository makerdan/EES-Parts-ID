/**
 * Server-side guard for POST /api/admin/catalog-pdf/runs/:id/unrevert.
 *
 * The UI greys out the Undo button when an older reverted run shares any
 * inventory rows with a NEWER enrichment run (server-computed
 * `undoBlocked` flag). This test exercises the server-side guard that
 * mirrors that flag, so a direct API call (or a race with the UI list
 * refresh) can't perform an unsafe undo even when the disabled-state UI
 * is bypassed.
 *
 * The test seeds two inventory rows directly, fabricates two enrichment
 * runs with their per-row history (older = reverted; newer = applied
 * after), then asserts:
 *
 *   1. /unrevert on the older run returns 409 + a clear error code, and
 *      neither the inventory rows nor the run's reverted_at marker is mutated
 *      (idempotent rejection — calling twice is safe).
 *   2. After the newer run is removed, the same /unrevert call succeeds
 *      and clears reverted_at.
 *
 * No PDF fixture is required — we drive the schema directly so this
 * suite runs even on developer machines without the Bridgeport catalog.
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
import { and, eq, inArray } from 'drizzle-orm';
import app from '../src/app';
import { signAdminToken } from '../src/routes/admin';
import { db, inventoryTable, enrichmentRunTable, enrichmentHistoryTable } from '@workspace/db';
import { closePool, cleanupFixtures } from './helpers/testDb';

const ADMIN_SECRET = 'jest-unrevert-guard-secret';
let adminToken: string;

const VENDOR = 'EATON';
const CATALOGS = ['JEST-ITG-UNREV-A', 'JEST-ITG-UNREV-B'] as const;

async function cleanupRows() {
  await db
    .delete(inventoryTable)
    .where(and(eq(inventoryTable.vendor, VENDOR), inArray(inventoryTable.catalog, [...CATALOGS])));
}

beforeAll(() => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
});

afterAll(async () => {
  try {
    await cleanupRows();
    await cleanupFixtures();
  } finally {
    await closePool();
  }
}, 30_000);

afterEach(async () => {
  await cleanupRows();
});

describe('POST /admin/catalog-pdf/runs/:id/unrevert — newer-run guard', () => {
  it('rejects with 409 when a newer run has touched the same items, and succeeds once the newer run is gone', async () => {
    // Seed two inventory rows we fully own.
    const seeded = await db
      .insert(inventoryTable)
      .values(
        CATALOGS.map((catalog) => ({
          vendor: VENDOR,
          catalog,
          description: 'pre-enrichment',
          aiKeywords: [] as string[],
        }))
      )
      .returning();
    expect(seeded).toHaveLength(2);
    const [rowA, rowB] = seeded;

    // ── Older run: applied, then reverted (so it currently shows Undo). ──
    const [olderRun] = await db
      .insert(enrichmentRunTable)
      .values({
        vendor: VENDOR,
        sourceFilename: 'older.pdf',
        finishedAt: new Date(),
        updatedCount: 2,
        skippedCount: 0,
        errorCount: 0,
        revertedAt: new Date(),
      })
      .returning();
    await db.insert(enrichmentHistoryTable).values([
      {
        runId: olderRun!.id,
        inventoryId: rowA!.id,
        catalogNumber: rowA!.catalog,
        beforeDescription: 'pre-enrichment',
        afterDescription: 'older description A',
        beforeKeywords: [],
        afterKeywords: ['older-a'],
      },
      {
        runId: olderRun!.id,
        inventoryId: rowB!.id,
        catalogNumber: rowB!.catalog,
        beforeDescription: 'pre-enrichment',
        afterDescription: 'older description B',
        beforeKeywords: [],
        afterKeywords: ['older-b'],
      },
    ]);

    // ── Newer run: writes a different value to ONE of the same rows. ──
    const [newerRun] = await db
      .insert(enrichmentRunTable)
      .values({
        vendor: VENDOR,
        sourceFilename: 'newer.pdf',
        finishedAt: new Date(),
        updatedCount: 1,
        skippedCount: 0,
        errorCount: 0,
      })
      .returning();
    await db.insert(enrichmentHistoryTable).values({
      runId: newerRun!.id,
      inventoryId: rowA!.id,
      catalogNumber: rowA!.catalog,
      beforeDescription: 'pre-enrichment',
      afterDescription: 'newer description A',
      beforeKeywords: [],
      afterKeywords: ['newer-a'],
    });
    // Reflect the newer run's write on the inventory row itself so we can
    // assert it isn't clobbered by a rejected unrevert attempt.
    await db
      .update(inventoryTable)
      .set({ description: 'newer description A', aiKeywords: ['newer-a'] })
      .where(eq(inventoryTable.id, rowA!.id));

    // 1. /unrevert on the older run must be rejected.
    const blocked = await supertest(app)
      .post(`/api/admin/catalog-pdf/runs/${olderRun!.id}/unrevert`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(blocked.body).toMatchObject({ code: 'newer_run_blocks_undo' });
    expect(typeof (blocked.body as { error?: string }).error).toBe('string');

    // Inventory row must still carry the newer value (no partial writes).
    const afterBlocked = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.id, rowA!.id));
    expect(afterBlocked[0]?.description).toBe('newer description A');
    expect(afterBlocked[0]?.aiKeywords).toEqual(['newer-a']);

    // Run must still be marked reverted (the rejection is fully atomic).
    const olderAfterBlock = await db
      .select()
      .from(enrichmentRunTable)
      .where(eq(enrichmentRunTable.id, olderRun!.id));
    expect(olderAfterBlock[0]?.revertedAt).not.toBeNull();

    // 2. Remove the newer run; the same call must now succeed.
    await db.delete(enrichmentRunTable).where(eq(enrichmentRunTable.id, newerRun!.id));

    const ok = await supertest(app)
      .post(`/api/admin/catalog-pdf/runs/${olderRun!.id}/unrevert`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(ok.body).toMatchObject({ runId: olderRun!.id, restored: 2 });

    // The older run's after_* values should now be on the inventory rows.
    const restored = await db
      .select()
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, [rowA!.id, rowB!.id]));
    const byId = new Map(restored.map((r) => [r.id, r]));
    expect(byId.get(rowA!.id)?.description).toBe('older description A');
    expect(byId.get(rowA!.id)?.aiKeywords).toEqual(['older-a']);
    expect(byId.get(rowB!.id)?.description).toBe('older description B');
    expect(byId.get(rowB!.id)?.aiKeywords).toEqual(['older-b']);

    const olderAfterOk = await db
      .select()
      .from(enrichmentRunTable)
      .where(eq(enrichmentRunTable.id, olderRun!.id));
    expect(olderAfterOk[0]?.revertedAt).toBeNull();

    // Cleanup: drop the older run (cascade removes its history).
    await db.delete(enrichmentRunTable).where(eq(enrichmentRunTable.id, olderRun!.id));
  }, 30_000);
});
