/**
 * @jest-environment node
 *
 * Unit tests for the drill-down refinement helpers used by the search screen.
 * These mirror the server's `matchesChipFilters` / `tokenMatch` algorithm so
 * client-side refinement stays consistent with what the server would have
 * returned had the chips been set up front.
 *
 * Helpers live in `lib/refinement.ts` (no React Native imports) so this test
 * runs cleanly in node-environment Jest without needing component mocks.
 */
import type { SearchResult } from "@workspace/api-client-react";
import { applyRefinement, itemFullText, tokenMatch } from "../lib/refinement";

function makeResult(overrides: Partial<SearchResult["item"]> & { id: number }): SearchResult {
  return {
    item: {
      id: overrides.id,
      vendor: overrides.vendor ?? "ETN",
      catalog: overrides.catalog ?? "BR120",
      description: overrides.description ?? "Eaton 20A 1-Pole Breaker",
      binLocations: overrides.binLocations ?? [],
      aiKeywords: overrides.aiKeywords ?? [],
      vendorFullName: overrides.vendorFullName ?? null,
      enrichedAt: overrides.enrichedAt ?? null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    confidence: 0.9,
    matchReason: "test",
    seriesLabel: undefined,
    variants: [],
  };
}

describe("itemFullText", () => {
  it("concatenates vendor, catalog, description and aiKeywords lower-cased", () => {
    const text = itemFullText({
      vendor: "ETN",
      catalog: "BR120",
      description: "Eaton 20A Breaker",
      aiKeywords: ["breaker", "20a"],
    });
    expect(text).toBe("etn br120 eaton 20a breaker breaker 20a");
  });

  it("handles missing aiKeywords (null) defensively", () => {
    // Generated client types `aiKeywords` as required string[], but the helper
    // is defensive against null in case server data drifts.
    const text = itemFullText({
      vendor: "SQD",
      catalog: "QO120",
      description: "Square D 20A Breaker",
      aiKeywords: null as unknown as string[],
    });
    expect(text).toContain("square d 20a breaker");
  });
});

describe("tokenMatch", () => {
  it("returns true for empty filter", () => {
    expect(tokenMatch("anything", "")).toBe(true);
    expect(tokenMatch("anything", "   ")).toBe(true);
  });

  it("matches whole-word tokens, not substrings", () => {
    expect(tokenMatch("eaton 20a breaker", "20A")).toBe(true);
    expect(tokenMatch("eaton 200a breaker", "20A")).toBe(false);
    expect(tokenMatch("eaton 20amp breaker", "20A")).toBe(false);
  });

  it("requires every token in a multi-word filter (AND)", () => {
    expect(tokenMatch("square d qo120 breaker", "Square D")).toBe(true);
    expect(tokenMatch("eaton br120 breaker", "Square D")).toBe(false);
    expect(tokenMatch("d square breaker", "Square D")).toBe(true); // order-independent
  });

  it("matches option values containing punctuation", () => {
    expect(tokenMatch('size 1/2" conduit', '1/2"')).toBe(true);
    expect(tokenMatch("size 1/2 conduit", '1/2"')).toBe(false);
  });
});

describe("applyRefinement", () => {
  const results: SearchResult[] = [
    makeResult({ id: 1, vendor: "ETN", catalog: "BR120", description: "Eaton 20A 1-Pole Breaker" }),
    makeResult({ id: 2, vendor: "SQD", catalog: "QO120", description: "Square D 20A 1-Pole Breaker" }),
    makeResult({ id: 3, vendor: "ETN", catalog: "BR230", description: "Eaton 30A 2-Pole Breaker" }),
    makeResult({ id: 4, vendor: "HUB", catalog: "5252", description: "Hubbell 20A White Receptacle" }),
  ];

  it("returns the input list unchanged when refinement is empty", () => {
    expect(applyRefinement(results, {})).toBe(results);
    expect(applyRefinement(results, { manufacturer: "" })).toBe(results);
  });

  it("filters by a single chip dimension", () => {
    const out = applyRefinement(results, { manufacturer: "Eaton" });
    expect(out.map(r => r.item.id)).toEqual([1, 3]);
  });

  it("ANDs multiple chip dimensions", () => {
    const out = applyRefinement(results, { manufacturer: "Eaton", amperage: "20A" });
    expect(out.map(r => r.item.id)).toEqual([1]);
  });

  it("returns an empty list when no item matches", () => {
    const out = applyRefinement(results, { manufacturer: "Leviton" });
    expect(out).toEqual([]);
  });

  it("matches against aiKeywords as well as description", () => {
    const r = makeResult({
      id: 99,
      vendor: "X",
      catalog: "Y",
      description: "no clue",
      aiKeywords: ["receptacle", "white"],
    });
    expect(applyRefinement([r], { category: "Receptacle" })).toHaveLength(1);
    expect(applyRefinement([r], { colorChip: "White" })).toHaveLength(1);
    expect(applyRefinement([r], { colorChip: "Black" })).toHaveLength(0);
  });
});
