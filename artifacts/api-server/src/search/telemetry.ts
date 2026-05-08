/**
 * Search telemetry helpers — Stage 1.
 *
 * Both exported functions are fire-and-forget: they wrap their DB operations
 * in try/catch and log errors to stderr. A failure here MUST NOT surface to
 * callers as a thrown exception, and must never add to the response latency
 * of a search request.
 */
import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';

export type QuerySource = 'typed' | 'barcode' | 'photo' | 'voice' | 'chip';
export type ClickAction = 'view' | 'add_to_list' | 'scan_confirm' | 'dismiss';

export interface LogSearchEventParams {
  queryRaw: string;
  queryNormalized: string;
  querySource: QuerySource;
  filtersJson: object;
  resultsCount: number;
  topResultId: number | null;
  latencyMs: number;
  layersHit: string[];
}

/**
 * Insert a row into `search_event` and return the new row id.
 * Returns -1n on failure (telemetry is non-critical).
 */
export async function logSearchEvent(params: LogSearchEventParams): Promise<bigint> {
  try {
    const result = await db.execute(sql`
      INSERT INTO search_event
        (query_raw, query_normalized, query_source, filters_json,
         results_count, top_result_id, latency_ms, layers_hit)
      VALUES
        (${params.queryRaw},
         ${params.queryNormalized},
         ${params.querySource},
         ${JSON.stringify(params.filtersJson)}::jsonb,
         ${params.resultsCount},
         ${params.topResultId},
         ${params.latencyMs},
         ${sql.raw(`ARRAY[${params.layersHit.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ')}]::text[]`)})
      RETURNING id
    `);
    const rows = (result as unknown as { rows: Array<{ id: unknown }> }).rows;
    const rawId = rows[0]?.id;
    if (rawId === undefined || rawId === null) return -1n;
    return BigInt(rawId as string | number);
  } catch (err) {
    console.error('[telemetry] logSearchEvent failed:', err);
    return -1n;
  }
}

/**
 * Insert a row into `search_event_click`.
 * Silently swallows errors — telemetry is non-critical.
 */
export async function logSearchClick(
  searchEventId: bigint,
  resultId: number,
  resultRank: number,
  action: ClickAction
): Promise<void> {
  if (searchEventId <= 0n) return;
  const VALID_ACTIONS: ClickAction[] = ['view', 'add_to_list', 'scan_confirm', 'dismiss'];
  if (!VALID_ACTIONS.includes(action)) return;
  try {
    await db.execute(sql`
      INSERT INTO search_event_click
        (search_event_id, result_id, result_rank, action)
      VALUES
        (${searchEventId}, ${resultId}, ${resultRank}, ${action})
    `);
  } catch (err) {
    console.error('[telemetry] logSearchClick failed:', err);
  }
}
