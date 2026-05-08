/**
 * Query normalization — Stage 1 of the search pipeline.
 *
 * Used in two places:
 *   1. As the first processing step inside POST /inventory/search
 *      (replaces the previous inline `normalizeMeasurement(allSearchText)` call
 *      for the query_normalized telemetry field).
 *   2. Stored verbatim in `search_event.query_normalized` so telemetry is
 *      consistent regardless of which layer expanded the query further.
 *
 * Rules (in order):
 *   - Trim leading/trailing whitespace.
 *   - Collapse internal whitespace runs to a single space.
 *   - Lowercase.
 *   - Strip combining diacritical marks via Unicode NFKD decomposition.
 *   - Preserve hyphens and forward-slashes (catalog numbers use both,
 *     e.g. "NM-B", "1/2").
 *
 * This function does NOT expand synonyms or abbreviations — those happen
 * later in the pipeline so they can be swapped out independently.
 */
export function normalizeQuery(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '');
}
