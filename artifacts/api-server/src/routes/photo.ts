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
import { eq, sql, and } from 'drizzle-orm';
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

// ── GET /photo/events ────────────────────────────────────────────────────────
// Paginated list of individual photo_id_event rows with optional filters.
// Joins inventory for top/confirmed result catalog+vendor.
// Query params:
//   - windowHours (default 24, min 1, max 720)
//   - parseOk (true | false; omit = any)
//   - matchType (string; omit = any)
//   - confirmed (yes | no; omit = any)
//   - page (default 1)
//   - limit (default 20, max 100)
// Admin Bearer required.
router.get('/events', requireAdminAuth, async (req, res) => {
  try {
    const rawWindow = parseInt(String(req.query['windowHours'] ?? '24'), 10);
    const windowHours = Number.isFinite(rawWindow) ? Math.min(720, Math.max(1, rawWindow)) : 24;
    const rawPage = parseInt(String(req.query['page'] ?? '1'), 10);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
    const rawLimit = parseInt(String(req.query['limit'] ?? '20'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
    const offset = (page - 1) * limit;

    const parseOkRaw = req.query['parseOk'];
    const parseOkFilter = parseOkRaw === 'true' ? true : parseOkRaw === 'false' ? false : undefined;

    const matchTypeFilter =
      typeof req.query['matchType'] === 'string' && req.query['matchType'].length > 0
        ? req.query['matchType']
        : undefined;

    const confirmedRaw = req.query['confirmed'];
    const confirmedFilter =
      confirmedRaw === 'yes' ? 'yes' : confirmedRaw === 'no' ? 'no' : undefined;

    // Build WHERE conditions for COUNT and data queries.
    const sinceCutoff = sql`now() - (${windowHours} || ' hours')::interval`;

    const whereConditions = and(
      sql`e.ts >= ${sinceCutoff}`,
      parseOkFilter !== undefined ? sql`e.parse_ok = ${parseOkFilter}` : undefined,
      matchTypeFilter !== undefined ? sql`e.match_type = ${matchTypeFilter}` : undefined,
      confirmedFilter === 'yes' ? sql`e.confirmed_result_id IS NOT NULL` : undefined,
      confirmedFilter === 'no' ? sql`e.confirmed_result_id IS NULL` : undefined
    );

    // Count total matching rows.
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM photo_id_event e
      WHERE ${whereConditions}
    `);
    const totalRows = (countResult as { rows: Record<string, unknown>[] }).rows;
    const total = Number(totalRows[0]?.['total'] ?? 0);

    // Fetch page of events, left-joining inventory twice for top/confirmed results.
    const dataResult = await db.execute(sql`
      SELECT
        e.id,
        e.ts,
        e.image_hash    AS "imageHash",
        e.parse_ok      AS "parseOk",
        e.catalog_guess AS "catalogGuess",
        e.vendor_guess  AS "vendorGuess",
        e.match_type    AS "matchType",
        e.latency_ms    AS "latencyMs",
        top.catalog     AS "topResultCatalog",
        top.vendor      AS "topResultVendor",
        conf.catalog    AS "confirmedResultCatalog",
        conf.vendor     AS "confirmedResultVendor",
        CASE
          WHEN e.vision_raw ? 'raw' THEN left(e.vision_raw->>'raw', 200)
          WHEN e.vision_raw IS NOT NULL THEN left(e.vision_raw::text, 200)
          ELSE NULL
        END             AS "visionRawSummary"
      FROM photo_id_event e
      LEFT JOIN ${inventoryTable} top  ON top.id  = e.top_result_id
      LEFT JOIN ${inventoryTable} conf ON conf.id = e.confirmed_result_id
      WHERE ${whereConditions}
      ORDER BY e.ts DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = (dataResult as { rows: Record<string, unknown>[] }).rows;
    const items = rows.map((r) => ({
      id: Number(r['id']),
      ts: String(r['ts']),
      imageHash: r['imageHash'] != null ? String(r['imageHash']) : null,
      parseOk: Boolean(r['parseOk']),
      catalogGuess: r['catalogGuess'] != null ? String(r['catalogGuess']) : null,
      vendorGuess: r['vendorGuess'] != null ? String(r['vendorGuess']) : null,
      matchType: r['matchType'] != null ? String(r['matchType']) : null,
      latencyMs: r['latencyMs'] != null ? Number(r['latencyMs']) : null,
      topResultCatalog: r['topResultCatalog'] != null ? String(r['topResultCatalog']) : null,
      topResultVendor: r['topResultVendor'] != null ? String(r['topResultVendor']) : null,
      confirmedResultCatalog:
        r['confirmedResultCatalog'] != null ? String(r['confirmedResultCatalog']) : null,
      confirmedResultVendor:
        r['confirmedResultVendor'] != null ? String(r['confirmedResultVendor']) : null,
      visionRawSummary: r['visionRawSummary'] != null ? String(r['visionRawSummary']) : null,
    }));

    res.json({ items, total, page, limit });
  } catch (err) {
    console.error('[photo/events]', err);
    res.status(500).json({ error: 'Failed to load photo events' });
  }
});

export default router;
