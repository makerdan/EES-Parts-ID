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

export type RefinementState = Record<string, string | undefined>;

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

/** Filter a results list by the active drill-down chip selections (AND-logic). */
export function applyRefinement(results: SearchResult[], refinement: RefinementState): SearchResult[] {
  const active = Object.entries(refinement).filter(([, v]) => !!v) as Array<[string, string]>;
  if (active.length === 0) return results;
  return results.filter(r => {
    const text = itemFullText(r.item);
    return active.every(([, v]) => tokenMatch(text, v));
  });
}
