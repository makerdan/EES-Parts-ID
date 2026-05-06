/**
 * Builds a denormalized search token string for an inventory row at
 * enrichment time.
 *
 * Motivation: instead of loading 5 lookup tables on every search request
 * to expand synonyms/slang/vendor aliases, we pre-compute the expansion
 * once per row and store it in `search_tokens`. The trigram index then
 * operates against that pre-expanded string.
 *
 * Algorithm:
 *   1. Collect all words from description, ai_keywords, catalog, vendor
 *      (lower-cased, split on whitespace / hyphens / slashes / commas).
 *   2. Build a joined base-text for phrase matching.
 *   3. For each synonym_group row, check whether the canonical term OR any
 *      synonym appears as a word (single-word terms) or phrase (multi-word
 *      terms) in the base text. If it matches, add ALL group members to the
 *      token set — bidirectional expansion.
 *   4. Return the deduplicated union joined with spaces.
 *
 * The result is intentionally readable text (not hashed) so that
 * similarity() in Postgres can compare it against a plain query string.
 */

export interface SynonymGroupRow {
  canonical: string;
  synonyms: string[];
}

/**
 * Expand an inventory row into a search token string by merging all
 * synonym groups that touch any word or phrase in the base fields.
 *
 * @param row          Inventory row subset used for token generation.
 * @param synonymGroups All rows from the `synonym_group` table.
 * @returns            Space-joined token string ready for storage in
 *                     `inventory.search_tokens`.
 */
export function buildSearchTokens(
  row: {
    catalog: string;
    description: string;
    vendor: string;
    aiKeywords: string[];
  },
  synonymGroups: SynonymGroupRow[],
): string {
  // ── Step 1: Build base text and word set ──────────────────────────────────
  // Join all source fields into a single lowercased string for phrase matching,
  // and split into a set of individual words for fast single-word lookups.
  const baseText = [
    row.catalog,
    row.description,
    row.vendor,
    ...row.aiKeywords,
  ]
    .join(" ")
    .toLowerCase();

  const baseWords = new Set(
    baseText
      .split(/[\s\-\/,]+/)
      .map(w => w.trim())
      .filter(w => w.length >= 2),
  );

  // ── Step 2: Expand synonym groups ─────────────────────────────────────────
  const tokens = new Set(baseWords);

  for (const group of synonymGroups) {
    const allTerms = [group.canonical, ...group.synonyms];

    const hasMatch = allTerms.some(term => {
      const tl = term.toLowerCase().trim();
      if (!tl) return false;
      // Multi-word phrase: check the full base text for the substring
      if (tl.includes(" ")) return baseText.includes(tl);
      // Single word: direct set lookup
      return baseWords.has(tl);
    });

    if (hasMatch) {
      for (const term of allTerms) {
        const tl = term.toLowerCase().trim();
        if (tl) tokens.add(tl);
      }
    }
  }

  return Array.from(tokens).join(" ");
}
