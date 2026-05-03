/**
 * Match catalog-PDF entries against existing inventory rows.
 *
 * Classification rules (per task spec):
 *   exact          identical catalog string after normalizing case, whitespace,
 *                  and dash variants
 *   highConfidence normalized exact match OR catalog number that differs only
 *                  by a known trailing variant suffix that the database
 *                  already has (e.g. `-DC` vs `-DC2`)
 *   uncertain      Levenshtein distance ≤ 2 OR shared stem with multiple
 *                  candidates
 *   unmatched      everything else
 */

import type { Inventory } from "@workspace/db";
import type { CatalogEntry } from "./catalogPdfParser";

/**
 * Trailing variant suffixes treated as interchangeable for high-confidence
 * matching. Color codes are intentionally excluded — `-SBLK` and `-SBLU` are
 * different SKUs, not variants of the same part, so they fall through to the
 * Levenshtein-distance branch which classifies them as "uncertain" (distance
 * 1 letter) and surfaces them in the review modal.
 */
const VARIANT_SUFFIXES = [
  "DC2", "DCI2", "DC", "DCI", "DCG", "DCX", "DCR", "DCX2",
  "MB", "MBI", "MS", "MSRT", "MSRTI",
  "SRT", "SRTI", "SRTI2", "RT", "RT2", "RTI", "RTI2",
  "LT", "LT2", "LTI", "LTI2", "SLT", "SLTI",
  "I", "SI", "SP", "SPMB",
  "G", "GI",
  "I2", "X", "XS", "UI", "XM", "UIX",
];

export function normalizeCatalog(s: string): string {
  return s
    .toUpperCase()
    .replace(/^#/, "")
    .replace(/\s+/g, "")
    // Treat various dash characters as the same.
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    // Strip a single trailing footnote marker.
    .replace(/\*$/, "");
}

/** Strip a known trailing variant suffix; return the bare stem. */
export function stripVariantSuffix(catalog: string): string {
  const norm = normalizeCatalog(catalog);
  // Try with leading dash first (most Bridgeport SKUs use `-DC2` etc.).
  for (const sfx of VARIANT_SUFFIXES) {
    if (norm.endsWith(`-${sfx}`)) return norm.slice(0, norm.length - sfx.length - 1);
  }
  // Then no-dash (some numeric-only suffixes).
  for (const sfx of VARIANT_SUFFIXES) {
    if (norm.endsWith(sfx) && norm.length > sfx.length) {
      const head = norm.slice(0, norm.length - sfx.length);
      // Only strip if the boundary makes sense (head ends with digit/letter).
      if (/[A-Z0-9]$/.test(head)) return head;
    }
  }
  return norm;
}

/** Classic Levenshtein distance (small strings only — no perf concerns here). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

export type MatchTier = "exact" | "highConfidence" | "uncertain" | "unmatched";

export interface MatchCandidate {
  inventoryId: number;
  vendor: string;
  catalog: string;
  description: string;
  /** Distance from this candidate to the catalog entry (0 = exact). */
  distance: number;
  /** Why this row is a candidate (for UI display). */
  reason: string;
}

export interface MatchResult {
  entry: CatalogEntry;
  tier: MatchTier;
  candidates: MatchCandidate[];
}

/**
 * Classify every PDF entry against the supplied vendor inventory rows.
 * `inventory` should already be filtered to the matching vendor — the
 * matcher does no vendor filtering itself.
 */
export function classifyEntries(
  entries: readonly CatalogEntry[],
  inventory: readonly Inventory[],
): MatchResult[] {
  // Pre-index the inventory by normalized catalog and by stem.
  const byNormalized = new Map<string, Inventory[]>();
  const byStem = new Map<string, Inventory[]>();
  for (const row of inventory) {
    const norm = normalizeCatalog(row.catalog);
    const arr = byNormalized.get(norm) ?? [];
    arr.push(row);
    byNormalized.set(norm, arr);

    const stem = stripVariantSuffix(row.catalog);
    const arr2 = byStem.get(stem) ?? [];
    arr2.push(row);
    byStem.set(stem, arr2);
  }

  const results: MatchResult[] = [];
  for (const entry of entries) {
    const norm = normalizeCatalog(entry.catalogNumber);
    const stem = stripVariantSuffix(entry.catalogNumber);

    // 1. Exact (normalized) match.
    const exactRows = byNormalized.get(norm) ?? [];
    if (exactRows.length === 1) {
      results.push({
        entry,
        tier: "exact",
        candidates: [toCandidate(exactRows[0]!, 0, "exact catalog match")],
      });
      continue;
    }
    if (exactRows.length > 1) {
      // Multiple inventory rows with the identical catalog (different vendor
      // casing, etc.). Treat as exact and return all.
      results.push({
        entry,
        tier: "exact",
        candidates: exactRows.map(r => toCandidate(r, 0, "exact catalog match")),
      });
      continue;
    }

    // 2. High-confidence: same stem, single candidate (variant suffix differs).
    const stemRows = byStem.get(stem) ?? [];
    if (stemRows.length === 1) {
      const r = stemRows[0]!;
      results.push({
        entry,
        tier: "highConfidence",
        candidates: [toCandidate(r, 1, "variant suffix differs")],
      });
      continue;
    }

    // 3. Uncertain: edit-distance ≤ 2 against any inventory row, OR shared
    //    stem with multiple candidates.
    const fuzzy: MatchCandidate[] = [];
    for (const row of inventory) {
      const d = levenshtein(norm, normalizeCatalog(row.catalog));
      if (d > 0 && d <= 2) {
        fuzzy.push(toCandidate(row, d, `distance ${d}`));
      }
    }
    // De-dupe stem rows into the fuzzy list (preserving the closer distance).
    for (const row of stemRows) {
      if (!fuzzy.some(c => c.inventoryId === row.id)) {
        fuzzy.push(toCandidate(row, levenshtein(norm, normalizeCatalog(row.catalog)), "shared stem"));
      }
    }
    if (fuzzy.length > 0) {
      fuzzy.sort((a, b) => a.distance - b.distance);
      results.push({ entry, tier: "uncertain", candidates: fuzzy.slice(0, 5) });
      continue;
    }

    // 4. Unmatched.
    results.push({ entry, tier: "unmatched", candidates: [] });
  }
  return results;
}

function toCandidate(row: Inventory, distance: number, reason: string): MatchCandidate {
  return {
    inventoryId: row.id,
    vendor: row.vendor,
    catalog: row.catalog,
    description: row.description,
    distance,
    reason,
  };
}

export interface MatchSummary {
  exact: number;
  highConfidence: number;
  uncertain: number;
  unmatched: number;
  total: number;
}

export function summarize(results: readonly MatchResult[]): MatchSummary {
  const s: MatchSummary = { exact: 0, highConfidence: 0, uncertain: 0, unmatched: 0, total: results.length };
  for (const r of results) {
    if (r.tier === "exact") s.exact++;
    else if (r.tier === "highConfidence") s.highConfidence++;
    else if (r.tier === "uncertain") s.uncertain++;
    else s.unmatched++;
  }
  return s;
}
