/**
 * Pure scoring/ranking utilities for the hybrid search pipeline.
 * Extracted from the inventory search route for unit testability.
 */

/**
 * Blend a PostgreSQL FTS rank and trigram similarity into a single base score.
 * Returns a value in [0, 0.95]; the +0.4 floor ensures any PG hit starts above
 * the Fuse.js fuzzy-fallback range (max ~0.70 * 0.95).
 *
 * Weighting rationale (empirically tuned against the electrical catalog):
 *   - 0.6 * ftsRank vs 0.4 * trgmSim — FTS lexeme rank is the stronger signal
 *     (it reflects term coverage/position), so it carries the majority weight;
 *     trigram similarity is a softer typo-tolerant tie-breaker.
 *   - +0.4 floor — a real PG index hit is inherently more trustworthy than a
 *     Fuse.js in-memory fuzzy fallback, so we lift every PG hit above that band
 *     to keep the two pipelines from interleaving badly.
 *   - 0.95 cap — leaves headroom below 1.0, which is reserved exclusively for an
 *     exact catalog-number match (see catalogScore).
 */
export function blendPgScore(ftsRank: number, trgmSim: number): number {
  return Math.min(0.95, ftsRank * 0.6 + trgmSim * 0.4 + 0.4);
}

/**
 * Determine the confidence score for a catalog item based on how well it
 * matches the user's catalog / keyword input.
 *
 * Priority (highest wins):
 *   1. Exact catalog match → 1.0
 *   2. Prefix match       → max(pgScore, 0.93)
 *   3. Substring match    → max(pgScore, 0.85)
 *   4. FTS/trigram match  → pgScore (reason "fts match" or "trigram match")
 */
export function catalogScore(
  pgScore: number,
  catalog: string,
  catalogInput: string,
  rawKeywords: string,
  ftsRank: number,
): { score: number; reason: string } {
  const c = catalog.toUpperCase();
  const ci = catalogInput.toUpperCase();
  const rk = rawKeywords.toUpperCase();

  if ((catalogInput && c === ci) || (rawKeywords && c === rk)) {
    return { score: 1.0, reason: "exact catalog" };
  }
  if ((catalogInput && c.startsWith(ci)) || (rawKeywords && c.startsWith(rk))) {
    return { score: Math.max(pgScore, 0.93), reason: "catalog prefix" };
  }
  if ((catalogInput && c.includes(ci)) || (rawKeywords && c.includes(rk))) {
    return { score: Math.max(pgScore, 0.85), reason: "catalog substring" };
  }

  // Belt-and-suspenders: also check each whitespace-separated token in rawKeywords.
  // This catches the case where the AI (or user) sends "CHB5 circuit breaker 20A" —
  // the full string won't match "CHB5", but the first token will.
  if (rawKeywords) {
    const tokens = rk.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (c === token) return { score: 1.0, reason: "exact catalog" };
      if (c.startsWith(token)) return { score: Math.max(pgScore, 0.93), reason: "catalog prefix" };
      if (c.includes(token)) return { score: Math.max(pgScore, 0.85), reason: "catalog substring" };
    }
  }

  // Same token-splitting for the catalogInput field: the Photo ID pipeline may
  // pass a multi-word string like "CHB5 circuit breaker 20A" in the catalog body
  // field rather than keywords. Split and test each token individually so the
  // matching part still earns its exact/prefix/substring boost.
  if (catalogInput) {
    const tokens = ci.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      for (const token of tokens) {
        if (c === token) return { score: 1.0, reason: "exact catalog" };
        if (c.startsWith(token)) return { score: Math.max(pgScore, 0.93), reason: "catalog prefix" };
        if (c.includes(token)) return { score: Math.max(pgScore, 0.85), reason: "catalog substring" };
      }
    }
  }

  return { score: pgScore, reason: ftsRank > 0 ? "fts match" : "trigram match" };
}

/**
 * Apply a vendor filter boost (+0.15, capped at 1.0) when the item's vendor
 * matches the filter, or a 50% penalty when it does not.
 * Returns the original confidence unchanged when no vendor filter is active.
 */
export function applyVendorBoost(
  confidence: number,
  vendorFilter: string,
  itemVendor: string,
): number {
  if (!vendorFilter) return confidence;
  if (itemVendor.toUpperCase() === vendorFilter.toUpperCase()) {
    return Math.min(1.0, confidence + 0.15);
  }
  return confidence * 0.5;
}

/**
 * Decide whether to record a new (item, confidence) score in the score map.
 * Returns true only when the new confidence is strictly better than the
 * current best, implementing "keep highest score" deduplication.
 */
export function shouldUpdateScore(
  currentConfidence: number | undefined,
  newConfidence: number,
): boolean {
  return currentConfidence === undefined || newConfidence > currentConfidence;
}

/**
 * Apply the Fuse.js raw score (where 0 = perfect match) to a confidence
 * value using the pipeline's configured weight.
 *
 * @param fuseScore  Raw Fuse score in [0, 1]; undefined treated as 0.5
 * @param weight     Multiplier applied to the inverted score (e.g. 0.70 or 0.60)
 */
export function fuseConfidence(fuseScore: number | undefined, weight: number): number {
  return (1 - (fuseScore ?? 0.5)) * weight;
}
