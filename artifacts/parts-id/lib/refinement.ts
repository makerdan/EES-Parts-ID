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

/**
 * Token-aware match: every word in `value` must appear as a whole token
 * in `text`. Token boundaries treat `/` and `-` as part of the token (in
 * addition to `\w`) so a chip like `1/2"` does NOT match inside `1-1/2"`
 * or `2-1/2"` — `-` and `/` would otherwise be treated as boundary chars
 * and let the smaller size leak into mixed-number sizes.
 */
export function tokenMatch(text: string, value: string): boolean {
  const tokens = value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every(tok => {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w/-])${escaped}(?![\\w/-])`, "i").test(text);
  });
}

/**
 * Collect the distinct, lower-cased whole-word tokens that are currently
 * narrowing the result list — i.e. the union of every chip selection's
 * tokens and every "extra keywords" token. Used by the result cards to
 * highlight matched terms in vendor / catalog / description / aiKeywords.
 *
 * Token boundaries match `tokenMatch` exactly (whitespace split, lower-
 * cased, empties dropped) so highlighting stays in sync with what
 * `applyRefinement` actually filtered on (no false highlights inside a
 * larger word like "20amp" when filtering by "20a").
 */
export function extractHighlightTokens(refinement: RefinementState): string[] {
  const all: string[] = [];
  for (const [k, v] of Object.entries(refinement)) {
    if (typeof v !== "string" || !v.trim()) continue;
    void k;
    for (const tok of v.toLowerCase().trim().split(/\s+/)) {
      if (tok) all.push(tok);
    }
  }
  return Array.from(new Set(all));
}

/**
 * Split `text` into alternating non-match / match segments according to
 * `tokens`. Each token matches as a whole word (same `(?<![\w])TOKEN(?![\w])`
 * boundary as `tokenMatch`) so we never highlight a substring inside a
 * larger word. Returns an array of `{ text, match }` slices ready to map
 * into <Text> spans. Empty tokens are ignored; if no tokens or no matches,
 * the result is a single non-match slice containing `text`.
 */
export function splitHighlightSegments(
  text: string,
  tokens: string[],
): Array<{ text: string; match: boolean }> {
  if (!text) return [{ text: "", match: false }];
  const cleaned = tokens.filter(t => t && t.trim());
  if (cleaned.length === 0) return [{ text, match: false }];
  const escaped = cleaned
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length); // longer first so "20a" wins over "20"
  const re = new RegExp(`(?<![\\w/-])(${escaped.join("|")})(?![\\w/-])`, "gi");
  const out: Array<{ text: string; match: boolean }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), match: false });
    out.push({ text: m[0], match: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // safety
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false });
  return out.length > 0 ? out : [{ text, match: false }];
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
    return activeChips.every(([k, v]) => {
      const chipText = k === "category"
        ? (r.item.aiKeywords ?? []).join(" ").toLowerCase()
        : text;
      return tokenMatch(chipText, v);
    });
  });
}
