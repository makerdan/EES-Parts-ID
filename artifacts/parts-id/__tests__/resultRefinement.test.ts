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
import {
  applyRefinement,
  extractHighlightTokens,
  itemFullText,
  splitHighlightSegments,
  tokenMatch,
} from "../lib/refinement";

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

  describe("extraKeywords (results-screen 'Add keywords' input)", () => {
    const baseResults: SearchResult[] = [
      makeResult({
        id: 10,
        vendor: "HUB",
        catalog: "5252W",
        description: "Hubbell 20A White Receptacle",
        aiKeywords: ["receptacle", "white", "duplex"],
      }),
      makeResult({
        id: 11,
        vendor: "HUB",
        catalog: "5252BL",
        description: "Hubbell 20A Blue Receptacle",
        aiKeywords: ["receptacle", "blue", "duplex"],
      }),
      makeResult({
        id: 12,
        vendor: "LEV",
        catalog: "WPB-50",
        description: "Leviton 50A Weatherproof Receptacle Cover",
        aiKeywords: ["receptacle", "weatherproof", "cover"],
      }),
    ];

    it("returns the input list unchanged when extraKeywords is empty or whitespace", () => {
      expect(applyRefinement(baseResults, { extraKeywords: "" })).toBe(baseResults);
      expect(applyRefinement(baseResults, { extraKeywords: "   " })).toBe(baseResults);
    });

    it("filters by a single extra keyword via whole-word match", () => {
      const out = applyRefinement(baseResults, { extraKeywords: "blue" });
      expect(out.map(r => r.item.id)).toEqual([11]);
    });

    it("ANDs multiple extra keywords (every word must match)", () => {
      const out = applyRefinement(baseResults, { extraKeywords: "weatherproof receptacle" });
      expect(out.map(r => r.item.id)).toEqual([12]);
    });

    it("ANDs extra keywords with chip refinements (AND across both)", () => {
      const out = applyRefinement(baseResults, {
        category: "Receptacle",
        extraKeywords: "blue",
      });
      expect(out.map(r => r.item.id)).toEqual([11]);
    });

    it("returns no results when extra keywords match no item", () => {
      const out = applyRefinement(baseResults, { extraKeywords: "nonexistent" });
      expect(out).toEqual([]);
    });

    it("trims surrounding whitespace before matching", () => {
      const out = applyRefinement(baseResults, { extraKeywords: "  white  " });
      expect(out.map(r => r.item.id)).toEqual([10]);
    });

    it("matches keywords found in aiKeywords as well as description", () => {
      const r = makeResult({
        id: 20,
        vendor: "X",
        catalog: "Y",
        description: "no clue",
        aiKeywords: ["weatherproof", "outdoor"],
      });
      expect(applyRefinement([r], { extraKeywords: "weatherproof" })).toHaveLength(1);
      expect(applyRefinement([r], { extraKeywords: "indoor" })).toHaveLength(0);
    });
  });
});

describe("extractHighlightTokens", () => {
  it("returns [] for empty refinement", () => {
    expect(extractHighlightTokens({})).toEqual([]);
  });

  it("returns [] when only empty/whitespace values are present", () => {
    expect(extractHighlightTokens({ extraKeywords: "   ", manufacturer: "" })).toEqual([]);
  });

  it("collects lower-cased tokens from extraKeywords", () => {
    expect(extractHighlightTokens({ extraKeywords: "20A Breaker" })).toEqual(["20a", "breaker"]);
  });

  it("collects tokens from chip selections too", () => {
    const out = extractHighlightTokens({ manufacturer: "Eaton", amperage: "20A" });
    expect(out).toEqual(expect.arrayContaining(["eaton", "20a"]));
    expect(out).toHaveLength(2);
  });

  it("dedupes tokens that appear in both chips and extraKeywords", () => {
    const out = extractHighlightTokens({ extraKeywords: "eaton 20a", manufacturer: "Eaton" });
    expect(out.sort()).toEqual(["20a", "eaton"]);
  });
});

describe("splitHighlightSegments", () => {
  it("returns one non-match slice when no tokens", () => {
    expect(splitHighlightSegments("Eaton 20A Breaker", [])).toEqual([
      { text: "Eaton 20A Breaker", match: false },
    ]);
  });

  it("returns one non-match slice when text has no matches", () => {
    expect(splitHighlightSegments("Square D 30A", ["eaton"])).toEqual([
      { text: "Square D 30A", match: false },
    ]);
  });

  it("highlights a whole-word token preserving original case", () => {
    const out = splitHighlightSegments("Eaton 20A Breaker", ["eaton"]);
    expect(out).toEqual([
      { text: "Eaton", match: true },
      { text: " 20A Breaker", match: false },
    ]);
  });

  it("does not highlight a substring inside a larger word", () => {
    // "20a" must NOT match inside "20amp" — same boundary as tokenMatch.
    const out = splitHighlightSegments("20amp service", ["20a"]);
    expect(out.every(s => !s.match)).toBe(true);
  });

  it("highlights every occurrence and across multiple tokens", () => {
    const out = splitHighlightSegments("Eaton BR120 20A breaker, eaton spec", ["eaton", "20a"]);
    const matches = out.filter(s => s.match).map(s => s.text.toLowerCase());
    expect(matches).toEqual(["eaton", "20a", "eaton"]);
  });

  it("prefers the longest token at overlapping starts", () => {
    // tokens "20" and "20a" both start at the same position; the longer
    // one should win so we highlight the full "20A" not just "20".
    const out = splitHighlightSegments("BR 20A 1P", ["20", "20a"]);
    const matches = out.filter(s => s.match).map(s => s.text);
    expect(matches).toEqual(["20A"]);
  });

  it("ignores empty tokens safely", () => {
    expect(splitHighlightSegments("Eaton 20A", ["", "  ", "eaton"]))
      .toEqual([
        { text: "Eaton", match: true },
        { text: " 20A", match: false },
      ]);
  });
});
