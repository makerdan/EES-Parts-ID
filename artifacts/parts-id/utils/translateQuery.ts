/**
 * translateQuery — AI natural-language query translation utility
 *
 * Extracted from SearchScreen (app/(tabs)/index.tsx) so the fetch/catch logic
 * can be unit-tested in isolation.  The function is intentionally dependency-
 * injected: callers supply a `getGen()` reader for the generation counter (a
 * ref in the component) and the two state-setter callbacks, so tests can
 * verify they are called without rendering the full screen.
 *
 * The critical invariant guarded by the tests:
 *   A network/HTTP failure MUST surface as `error: "AI unavailable"` in
 *   aiZeroResults when zeroResults=true — it must NOT be silently swallowed.
 */

import type { SearchResult } from "@workspace/api-client-react";

export type AIZeroResultsState = {
  loading: boolean;
  partName: string;
  partSpecs: Array<string>;
  catalogNumbers: Array<string>;
  substitutes: Array<SearchResult>;
  error: string | null;
};

export type TranslateQueryDeps = {
  apiBase: string;
  /** Returns the current generation counter value from the ref. */
  getGen: () => number;
  setAIZeroResults: (state: AIZeroResultsState) => void;
  setAITranslation: (t: { terms: Array<string>; interpretation: string }) => void;
  setAITranslationDismissed: (v: boolean) => void;
};

export async function runTranslateQuery(
  query: string,
  zeroResults: boolean,
  gen: number,
  deps: TranslateQueryDeps,
): Promise<void> {
  const { apiBase, getGen, setAIZeroResults, setAITranslation, setAITranslationDismissed } = deps;

  const markError = () => {
    if (getGen() !== gen) return;
    if (zeroResults) {
      setAIZeroResults({
        loading: false,
        partName: "",
        partSpecs: [],
        catalogNumbers: [],
        substitutes: [],
        error: "AI unavailable",
      });
    }
  };

  try {
    const res = await fetch(`${apiBase}/ai/translate-query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, zeroResults }),
    });
    if (getGen() !== gen) return;
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      translatedTerms?: Array<string>;
      interpretation?: string;
      appliedTranslation?: boolean;
      partName?: string;
      partSpecs?: Array<string>;
      catalogNumbers?: Array<string>;
      substitutes?: Array<SearchResult>;
      error?: string;
    } | null;
    if (getGen() !== gen) return;
    if (!data) {
      markError();
      return;
    }
    if (zeroResults) {
      setAIZeroResults({
        loading: false,
        partName: data.partName ?? "",
        partSpecs: data.partSpecs ?? [],
        catalogNumbers: data.catalogNumbers ?? [],
        substitutes: data.substitutes ?? [],
        error: null,
      });
    } else if (data.appliedTranslation && (data.translatedTerms?.length ?? 0) > 0) {
      setAITranslation({
        terms: data.translatedTerms!,
        interpretation: data.interpretation ?? "",
      });
      setAITranslationDismissed(false);
    }
  } catch (err) {
    console.error("[index] translateQuery", err);
    markError();
  }
}
