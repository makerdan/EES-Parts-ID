/**
 * Pure scoring/ranking utilities for the hybrid search pipeline.
 * Extracted from the inventory search route for unit testability.
 */

/**
 * Blend a PostgreSQL FTS rank and trigram similarity into a single base score.
 *
 * The raw `ts_rank_cd` output is first normalized with `ftsRaw / (ftsRaw + 1)`
 * which maps [0, ∞) → [0, 1) so that high-scoring FTS hits don't dominate the
 * blend. The blend weights are 65% FTS and 35% trigram. No additive floor is
 * applied — weak matches stay weak so the `confidenceThreshold` drop-floor
 * (0.05 minimum) can filter them cleanly.
 *
 * The weight coefficients used by `ts_rank_cd` in the SQL query are
 * `'{0.1, 0.3, 0.6, 1.0}'` (D→C→B→A), meaning catalog number hits (weight A)
 * score up to 10× higher than ai_keyword hits (weight D).
 */
export function blendPgScore(ftsRaw: number, trgmSim: number): number {
  const ftsNorm = ftsRaw / (ftsRaw + 1); // maps [0, ∞) → [0, 1)
  return 0.65 * ftsNorm + 0.35 * trgmSim;
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
 *
 * For rawKeywords, both the full string AND each individual whitespace-delimited
 * token are checked at every tier. This ensures that when Photo ID returns a
 * multi-word keyword string like "NMWH43 circuit breaker 20A Square D", the
 * single token "NMWH43" still triggers an exact-match boost against a catalog
 * entry of "NMWH43".
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
  const tokens = rk ? rk.split(/\s+/).filter(Boolean) : [];

  if (
    (catalogInput && c === ci) ||
    (rawKeywords && c === rk) ||
    tokens.some(t => t === c)
  ) {
    return { score: 1.0, reason: "exact catalog" };
  }
  if (
    (catalogInput && c.startsWith(ci)) ||
    (rawKeywords && c.startsWith(rk)) ||
    tokens.some(t => c.startsWith(t))
  ) {
    return { score: Math.max(pgScore, 0.93), reason: "catalog prefix" };
  }
  if (
    (catalogInput && c.includes(ci)) ||
    (rawKeywords && c.includes(rk)) ||
    tokens.some(t => c.includes(t))
  ) {
    return { score: Math.max(pgScore, 0.85), reason: "catalog substring" };
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
