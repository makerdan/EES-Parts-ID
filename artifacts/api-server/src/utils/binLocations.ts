/**
 * Helpers for working with the multi-bin representation on inventory parts.
 *
 * A bin cell from a spreadsheet may contain several bins squashed together
 * with separators (comma, semicolon, slash, newline). Two rows for the same
 * (vendor, catalog) may also each contribute their own bins. Both cases are
 * handled by splitting cells into atomic bins, then merging additively into
 * the part's existing list while case-insensitively de-duplicating.
 *
 * Merge rule across the codebase: ADDITIVE ONLY. Re-importing a spreadsheet
 * never removes an existing bin — it only adds new ones. Bin removal is
 * intentionally out of scope of the importer; admins must clear bins
 * directly via the upsert API if they need to.
 */

const BIN_CELL_SEPARATORS = /[,;/\n\r]+/;

/**
 * Split a single bin cell from a spreadsheet into its constituent bins.
 * Trims whitespace; drops empty entries. Does NOT de-duplicate — that is the
 * caller's responsibility (so dedupe always happens after merging with
 * existing bins, never before).
 */
export function splitBinCell(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(BIN_CELL_SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Case-insensitively de-duplicate a list of bin labels while preserving
 * insertion order and the original casing of the first occurrence.
 *
 * Example: ["a-12", "B-04", "A-12"] → ["a-12", "B-04"]
 */
export function dedupeBinsCaseInsensitive(bins: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const b of bins) {
    const trimmed = b.trim();
    if (!trimmed) continue;
    const key = trimmed.toUpperCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return Array.from(seen.values());
}

/**
 * Additive merge: append `incoming` bins to `existing`, then case-insensitively
 * de-duplicate. Existing bins always win (their casing is preserved).
 */
export function mergeBins(
  existing: readonly string[] | null | undefined,
  incoming: readonly string[] | null | undefined,
): string[] {
  return dedupeBinsCaseInsensitive([...(existing ?? []), ...(incoming ?? [])]);
}

/**
 * Group spreadsheet rows by (vendor, catalog) (case-insensitive on vendor,
 * case-sensitive on catalog to match the unique index semantics). Bins from
 * every row are split, accumulated, and case-insensitively de-duplicated.
 * The first non-empty `description` encountered wins.
 */
export interface RawSpreadsheetRow {
  vendor: string;
  catalog: string;
  description?: string;
  /** Either a single raw cell (will be split) or an already-split list. */
  binCell?: string;
  binLocations?: string[];
}

export interface AggregatedRow {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: string[];
}

export function aggregateRowsByPart(rows: readonly RawSpreadsheetRow[]): AggregatedRow[] {
  const byKey = new Map<string, AggregatedRow>();
  for (const row of rows) {
    const vendor = row.vendor.trim().toUpperCase();
    const catalog = row.catalog.trim();
    if (!vendor || !catalog) continue;
    const key = `${vendor}|${catalog}`;
    const incoming = [
      ...splitBinCell(row.binCell),
      ...(row.binLocations ?? []),
    ];
    const existing = byKey.get(key);
    if (existing) {
      existing.binLocations = mergeBins(existing.binLocations, incoming);
      if (!existing.description && row.description) {
        existing.description = row.description.trim();
      }
    } else {
      byKey.set(key, {
        vendor,
        catalog,
        description: (row.description ?? "").trim(),
        binLocations: dedupeBinsCaseInsensitive(incoming),
      });
    }
  }
  return Array.from(byKey.values());
}
