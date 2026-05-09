/**
 * Enrichment and parse invalidation helpers.
 *
 * These constants and functions determine whether an inventory item needs
 * to be re-enriched (AI keywords) or re-parsed (structural attributes).
 * Bump the version constants whenever the corresponding algorithm changes.
 */

/**
 * Current AI prompt version. Increment this to force all items to be
 * re-enriched on the next bulk-enrich run, even if they were already
 * processed under an older prompt.
 */
export const CURRENT_PROMPT_VERSION = 1;

/**
 * Current catalog parser version. Increment this to force the backfill
 * script to re-parse all items that were previously parsed with an older
 * version of parseCatalog (i.e. whose catalog_parse.parser_version < this).
 */
export const CURRENT_PARSER_VERSION = 5;

/**
 * Returns true when the item's AI keyword enrichment is stale and should
 * be regenerated.
 *
 * An item needs re-enrichment when:
 *   1. It has never been enriched (enrichedAt is null).
 *   2. The item's content was updated after the last enrichment
 *      (updatedAt > enrichedAt) — description change, catalog rename, etc.
 *   3. The stored prompt version is older than CURRENT_PROMPT_VERSION,
 *      meaning the AI was given a different (worse) prompt last time.
 *   4. The stored parser version is older than CURRENT_PARSER_VERSION,
 *      meaning the parse logic has improved and attributes need refreshing.
 */
export function shouldReenrich(item: {
  enrichedAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
  promptVersion: number | null | undefined;
  catalogParse?: { parser_version?: number } | null | undefined;
}): boolean {
  if (!item.enrichedAt) return true;

  if (
    item.updatedAt instanceof Date &&
    item.enrichedAt instanceof Date &&
    item.updatedAt > item.enrichedAt
  ) {
    return true;
  }

  if ((item.promptVersion ?? 0) < CURRENT_PROMPT_VERSION) return true;

  const storedParserVersion =
    (item.catalogParse as { parser_version?: number } | null)?.parser_version ?? 0;
  if (storedParserVersion < CURRENT_PARSER_VERSION) return true;

  return false;
}

/**
 * Returns true when the item's materialized parse attributes are stale
 * and should be recomputed by the backfill script.
 *
 * An item needs re-parsing when:
 *   1. It has never been parsed (attrsParsedAt is null).
 *   2. The stored parser_version inside catalog_parse is older than
 *      CURRENT_PARSER_VERSION, meaning the parse logic has since improved.
 */
export function shouldReparse(item: {
  attrsParsedAt: Date | null | undefined;
  catalogParse: { parser_version?: number } | null | undefined;
}): boolean {
  if (!item.attrsParsedAt) return true;

  const storedVersion =
    (item.catalogParse as { parser_version?: number } | null)?.parser_version ?? 0;
  if (storedVersion < CURRENT_PARSER_VERSION) return true;

  return false;
}
