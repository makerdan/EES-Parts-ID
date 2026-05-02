/**
 * Pure helpers for client-side drill-down refinement on already-returned
 * search results. Mirrors the server's matchesChipFilters / tokenMatch
 * algorithm in artifacts/api-server/src/utils/searchHelpers.ts so a
 * client-side refinement chip narrows the result set the same way the
 * server would have if the chip had been set up front.
 *
 * Kept in its own file (no React Native imports) so it can be unit-tested
 * in a pure node-environment Jest run.
 */
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";

/**
 * Refinement state shape. Chip-dimension keys (e.g. `manufacturer`,
 * `amperage`) hold a single chosen option string; the reserved key
 * `extraKeywords` holds free-text the user typed in the results-screen
 * "Add keywords" input. Both are applied as AND-logic filters against the
 * combined item text.
 */
export type RefinementState = {
  /**
   * Free-text keywords typed on the results screen to narrow the in-memory
   * result list. Matched against the same combined item text used for chip
   * refinements via `tokenMatch` so behavior stays consistent.
   */
  extraKeywords?: string;
  /** Chip-dimension selections, keyed by FilterValues chip key. */
  [chipKey: string]: string | undefined;
};

/** Reserved key in RefinementState that holds free-text refinement input. */
export const EXTRA_KEYWORDS_KEY = "extraKeywords" as const;

export function itemFullText(
  item: Pick<InventoryItem, "vendor" | "catalog" | "description" | "aiKeywords">,
): string {
  return `${item.vendor} ${item.catalog} ${item.description} ${(item.aiKeywords ?? []).join(" ")}`.toLowerCase();
}

/** Token-aware match: every word in `value` must appear as a whole word in `text`. */
export function tokenMatch(text: string, value: string): boolean {
  const tokens = value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every(tok => {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "i").test(text);
  });
}

/**
 * Filter a results list by the active drill-down chip selections AND any
 * free-text "extra keywords" the user typed in the results-screen input
 * (AND-logic across both). Both kinds of refinement reuse `tokenMatch`
 * against `itemFullText`, so behavior is consistent with how a chip would
 * have narrowed the original server response.
 */
export function applyRefinement(results: SearchResult[], refinement: RefinementState): SearchResult[] {
  const { [EXTRA_KEYWORDS_KEY]: rawExtra, ...chipRefinement } = refinement;
  const activeChips = Object.entries(chipRefinement).filter(([, v]) => !!v) as Array<[string, string]>;
  const extra = rawExtra?.trim() ? rawExtra.trim() : null;
  if (activeChips.length === 0 && !extra) return results;
  return results.filter(r => {
    const text = itemFullText(r.item);
    if (extra && !tokenMatch(text, extra)) return false;
    return activeChips.every(([, v]) => tokenMatch(text, v));
  });
}
