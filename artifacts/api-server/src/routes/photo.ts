/**
 * Photo ID routes.
 *   POST /photo/confirm — worker signals which result matched the photo.
 *   GET  /photo/stats   — admin-only telemetry dashboard aggregation.
 *
 * /photo/confirm needs no auth: workers are anonymous; the photoEventId acts
 * as a non-secret correlation handle (sequential bigserial).
 * /photo/stats is admin-only — same Bearer pattern as other /admin/* routes.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { db, inventoryTable, photoIdEventTable } from '@workspace/db';
import { eq, sql } from 'drizzle-orm';
import { verifyAdminToken } from './admin';

const router = Router();

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: 'Admin access is not configured.' });
    return;
  }
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: 'Unauthorized: valid admin token required' });
    return;
  }
  next();
}

router.post('/confirm', async (req, res) => {
  try {
    const { photoEventId, resultId } = req.body as {
      photoEventId?: unknown;
      resultId?: unknown;
    };

    const eventId = typeof photoEventId === 'number' ? photoEventId : Number(photoEventId);
    const resId = typeof resultId === 'number' ? resultId : Number(resultId);

    if (!Number.isFinite(eventId) || eventId <= 0) {
      return void res.status(400).json({ error: 'photoEventId must be a positive integer' });
    }
    if (!Number.isFinite(resId) || resId <= 0) {
      return void res.status(400).json({ error: 'resultId must be a positive integer' });
    }

    const [updated] = await db
      .update(photoIdEventTable)
      .set({ confirmedResultId: resId })
      .where(eq(photoIdEventTable.id, eventId))
      .returning({ id: photoIdEventTable.id });

    if (!updated) {
      return void res.status(404).json({ error: 'Photo ID event not found' });
    }

    res.json({ ok: true, photoEventId: eventId, confirmedResultId: resId });
  } catch (err) {
    console.error('[photo/confirm]', err);
    res.status(500).json({ error: 'Failed to record confirmation' });
  }
});

// ── GET /photo/stats ────────────────────────────────────────────────────────
// Aggregated telemetry over a configurable window.
// Query params:
//   - windowHours (default 24, min 1, max 720 = 30d)
// All aggregation happens in SQL; we never pull individual event rows to the
// client. Admin Bearer required.
router.get('/stats', requireAdminAuth, async (req, res) => {
  try {
    const rawWindow = parseInt(String(req.query['windowHours'] ?? '24'), 10);
    const windowHours = Number.isFinite(rawWindow) ? Math.min(720, Math.max(1, rawWindow)) : 24;

    // Single round-trip aggregation. Everything is bucketed since `since`.
    const sinceCutoff = sql`now() - (${windowHours} || ' hours')::interval`;

    // Single round-trip: one CTE for the windowed event slice, then a JSON
    // overview row UNION-ed with up to 10 top-confirmed-parts rows.
    const result = await db.execute(sql`
      WITH windowed AS (
        SELECT *
        FROM photo_id_event
        WHERE ts >= ${sinceCutoff}
      ),
      overview AS (
        SELECT
          COUNT(*)::int AS total_scans,
          COUNT(*) FILTER (WHERE parse_ok)::int AS parse_ok_count,
          COUNT(*) FILTER (WHERE top_result_id IS NOT NULL)::int AS with_top_result,
          COUNT(*) FILTER (WHERE confirmed_result_id IS NOT NULL)::int AS confirmed_count,
          COUNT(*) FILTER (WHERE match_type = 'catalog_exact')::int AS catalog_exact_count,
          COUNT(*) FILTER (WHERE match_type = 'attribute_match')::int AS attribute_match_count,
          COUNT(*) FILTER (WHERE match_type = 'descriptive')::int AS descriptive_count,
          AVG(latency_ms)::int AS avg_latency_ms,
          (percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_latency_ms
        FROM windowed
      ),
      top_parts AS (
        SELECT
          i.id AS inventory_id,
          i.catalog,
          i.vendor,
          COUNT(*)::int AS confirmed_count
        FROM windowed w
        JOIN ${inventoryTable} i ON i.id = w.confirmed_result_id
        WHERE w.confirmed_result_id IS NOT NULL
        GROUP BY i.id, i.catalog, i.vendor
        ORDER BY confirmed_count DESC, i.catalog ASC
        LIMIT 10
      )
      SELECT 'overview' AS kind, row_to_json(overview) AS payload FROM overview
      UNION ALL
      SELECT 'top_part' AS kind, row_to_json(top_parts) AS payload FROM top_parts
    `);
    const allRows = (result as { rows: Record<string, unknown>[] }).rows;
    const overviewPayload =
      (allRows.find((r) => r['kind'] === 'overview')?.['payload'] as
        | Record<string, unknown>
        | undefined) ?? {};
    const topRows = allRows
      .filter((r) => r['kind'] === 'top_part')
      .map((r) => r['payload'] as Record<string, unknown>);
    const num = (k: string): number => Number(overviewPayload[k] ?? 0);
    const numOrNull = (k: string): number | null => {
      const v = overviewPayload[k];
      return v == null ? null : Number(v);
    };

    const total = num('total_scans');
    const parseOk = num('parse_ok_count');
    const withTop = num('with_top_result');
    const confirmed = num('confirmed_count');

    res.json({
      windowHours,
      totalScans: total,
      parseSuccessRate: total > 0 ? parseOk / total : 0,
      confirmationRate: withTop > 0 ? confirmed / withTop : 0,
      matchTypeDistribution: {
        catalogExact: num('catalog_exact_count'),
        attributeMatch: num('attribute_match_count'),
        descriptive: num('descriptive_count'),
      },
      avgLatencyMs: numOrNull('avg_latency_ms'),
      p95LatencyMs: numOrNull('p95_latency_ms'),
      topConfirmedParts: topRows.map((r) => ({
        inventoryId: Number(r['inventory_id']),
        catalog: String(r['catalog'] ?? ''),
        vendor: String(r['vendor'] ?? ''),
        confirmedCount: Number(r['confirmed_count'] ?? 0),
      })),
    });
  } catch (err) {
    console.error('[photo/stats]', err);
    res.status(500).json({ error: 'Failed to load photo stats' });
  }
});

export default router;
