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
 *   4. For each abbreviation_map row, if the abbreviation OR any of its
 *      expansions appears in the base text, add all (abbreviation + expansions)
 *      to the token set — bidirectional expansion.
 *   5. For each electrical_slang_map row, if the slang term OR any standard
 *      term appears in the base text, add all (slang + standard terms) to the
 *      token set — bidirectional expansion.
 *   6. For each misspelling_map row, if the correct spelling appears in the
 *      base text, add the common misspelling to the token set — this allows
 *      searches that bypass query-side correction to still find the part.
 *   7. Return the deduplicated union joined with spaces.
 *
 * The result is intentionally readable text (not hashed) so that
 * similarity() in Postgres can compare it against a plain query string.
 *
 * The additional dictionary parameters (abbreviationMaps, slangMaps,
 * misspellingMaps) are optional so existing callers continue to work
 * without modification; pass them in the rebuild-tokens job for the
 * most complete expansion.
 */

export interface SynonymGroupRow {
  canonical: string;
  synonyms: string[];
}

export interface AbbreviationMapRow {
  abbreviation: string;
  expansions: string[];
}

export interface SlangMapRow {
  slangTerm: string;
  standardTerms: string[];
}

export interface MisspellingMapRow {
  misspelling: string;
  correction: string;
}

/**
 * Expand an inventory row into a search token string by merging all
 * synonym groups and optional dictionary tables that touch any word
 * or phrase in the base fields.
 *
 * @param row            Inventory row subset used for token generation.
 * @param synonymGroups  All rows from the `synonym_group` table.
 * @param opts           Optional additional dictionaries to incorporate.
 * @returns              Space-joined token string ready for storage in
 *                       `inventory.search_tokens`.
 */
export function buildSearchTokens(
  row: {
    catalog: string;
    description: string;
    vendor: string;
    aiKeywords: string[];
  },
  synonymGroups: SynonymGroupRow[],
  opts?: {
    abbreviationMaps?: AbbreviationMapRow[];
    slangMaps?: SlangMapRow[];
    misspellingMaps?: MisspellingMapRow[];
  },
): string {
  // ── Step 1: Build base text and word set ──────────────────────────────────
  // Join all source fields into a single lowercased string for phrase matching,
  // and split into a set of individual words for fast single-word lookups.
  const baseText = [row.catalog, row.description, row.vendor, ...row.aiKeywords]
    .join(' ')
    .toLowerCase();

  const baseWords = new Set(
    baseText
      .split(/[\s\-\/,]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2)
  );

  // ── Step 2: Expand synonym groups ─────────────────────────────────────────
  const tokens = new Set(baseWords);

  for (const group of synonymGroups) {
    const allTerms = [group.canonical, ...group.synonyms];

    const hasMatch = allTerms.some((term) => {
      const tl = term.toLowerCase().trim();
      if (!tl) return false;
      // Multi-word phrase: check the full base text for the substring
      if (tl.includes(' ')) return baseText.includes(tl);
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

  // ── Step 3: Expand abbreviations (bidirectional) ──────────────────────────
  // abbreviation_map: abbreviation ↔ expansions[]
  // If the part text contains the abbreviation OR any expansion, inject all.
  for (const entry of opts?.abbreviationMaps ?? []) {
    const abbrevLower = entry.abbreviation.toLowerCase().trim();
    const hasAbbrev = abbrevLower.includes(' ')
      ? baseText.includes(abbrevLower)
      : baseWords.has(abbrevLower);

    const hasExpansion = entry.expansions.some((e) => {
      const el = e.toLowerCase().trim();
      return el.includes(' ') ? baseText.includes(el) : baseWords.has(el);
    });

    if (hasAbbrev || hasExpansion) {
      if (abbrevLower) tokens.add(abbrevLower);
      for (const exp of entry.expansions) {
        const el = exp.toLowerCase().trim();
        if (el) tokens.add(el);
      }
    }
  }

  // ── Step 4: Expand electrical slang (bidirectional) ──────────────────────
  // electrical_slang_map: slangTerm ↔ standardTerms[]
  // If the part text contains the slang OR any standard term, inject all.
  for (const entry of opts?.slangMaps ?? []) {
    const slangLower = entry.slangTerm.toLowerCase().trim();
    const hasSlang = slangLower.includes(' ')
      ? baseText.includes(slangLower)
      : baseWords.has(slangLower);

    const hasStandard = entry.standardTerms.some((t) => {
      const tl = t.toLowerCase().trim();
      return tl.includes(' ') ? baseText.includes(tl) : baseWords.has(tl);
    });

    if (hasSlang || hasStandard) {
      if (slangLower) tokens.add(slangLower);
      for (const term of entry.standardTerms) {
        const tl = term.toLowerCase().trim();
        if (tl) tokens.add(tl);
      }
    }
  }

  // ── Step 5: Inject common misspellings (one-directional) ─────────────────
  // misspelling_map: misspelling → correction
  // If the part's text contains the *correct* spelling, add the misspelling
  // to tokens so that searches bypassing query-side correction still succeed.
  for (const entry of opts?.misspellingMaps ?? []) {
    const corrLower = entry.correction.toLowerCase().trim();
    const misspLower = entry.misspelling.toLowerCase().trim();
    const hasCorrection = corrLower.includes(' ')
      ? baseText.includes(corrLower)
      : baseWords.has(corrLower);
    if (hasCorrection && misspLower) tokens.add(misspLower);
  }

  return Array.from(tokens).join(' ');
}
