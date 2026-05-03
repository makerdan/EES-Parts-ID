/**
 * Unit tests for the catalog-PDF match classifier.
 *
 * Fixtures use catalog numbers drawn directly from the Bridgeport 2026
 * INDEX BY CATALOG NUMBER pages so the classifier behaviour stays in sync
 * with what the parser actually emits.
 */

import {
  classifyEntries,
  normalizeCatalog,
  stripVariantSuffix,
  levenshtein,
  summarize,
} from "../src/utils/catalogMatch";
import type { CatalogEntry } from "../src/utils/catalogPdfParser";
import type { Inventory } from "@workspace/db";

function inv(id: number, catalog: string, description = ""): Inventory {
  return {
    id,
    vendor: "BRIDGEPORT",
    catalog,
    description,
    binLocations: [],
    aiKeywords: [],
    enrichedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function entry(catalogNumber: string, page = 100): CatalogEntry {
  return {
    catalogNumber,
    pageNumbers: [page],
    description: `${catalogNumber} from index`,
    dimensions: {},
    keywords: [],
  };
}

describe("normalizeCatalog", () => {
  it("uppercases and strips whitespace", () => {
    expect(normalizeCatalog("  239-dc2 ")).toBe("239-DC2");
  });
  it("strips a leading #", () => {
    expect(normalizeCatalog("#30-DC2")).toBe("30-DC2");
  });
  it("strips a trailing footnote *", () => {
    expect(normalizeCatalog("268-RT*")).toBe("268-RT");
  });
  it("normalizes unicode dashes to ASCII", () => {
    expect(normalizeCatalog("239\u2013DC2")).toBe("239-DC2");
  });
});

describe("stripVariantSuffix", () => {
  it("strips -DC", () => {
    expect(stripVariantSuffix("40-DC")).toBe("40");
  });
  it("strips -DC2", () => {
    expect(stripVariantSuffix("239-DC2")).toBe("239");
  });
  it("greedy: -DCI2 wins over -DC", () => {
    expect(stripVariantSuffix("230-DCI2")).toBe("230");
  });
  it("does NOT strip a color suffix (color is SKU identity)", () => {
    // -SBLK / -SBLU / -SR etc. are different products, not variants — keep
    // them intact so the matcher classifies them as "uncertain" instead of
    // collapsing every color into one inventory row.
    expect(stripVariantSuffix("231-SBLK")).toBe("231-SBLK");
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("ABC", "ABC")).toBe(0);
  });
  it("counts a single substitution", () => {
    expect(levenshtein("ABC", "ABD")).toBe(1);
  });
  it("counts insertion + substitution", () => {
    expect(levenshtein("239-DC", "239-DCI")).toBe(1);
    expect(levenshtein("239-DC2", "239-DCI2")).toBe(1);
  });
});

describe("classifyEntries", () => {
  it("returns exact when the inventory has the same catalog", () => {
    const results = classifyEntries(
      [entry("239-DC2")],
      [inv(1, "239-DC2", "Existing 239-DC2")],
    );
    expect(results[0]!.tier).toBe("exact");
    expect(results[0]!.candidates).toHaveLength(1);
    expect(results[0]!.candidates[0]!.inventoryId).toBe(1);
  });

  it("normalizes case and dashes for exact matching", () => {
    const results = classifyEntries(
      [entry("#239-dc2")],
      [inv(1, "239-DC2")],
    );
    expect(results[0]!.tier).toBe("exact");
  });

  it("treats a variant suffix mismatch as high-confidence with one candidate", () => {
    const results = classifyEntries(
      [entry("239-DC2")],
      [inv(1, "239-DC")],
    );
    expect(results[0]!.tier).toBe("highConfidence");
    expect(results[0]!.candidates[0]!.catalog).toBe("239-DC");
  });

  it("downgrades to uncertain when multiple stem siblings exist", () => {
    const results = classifyEntries(
      [entry("239-DC2")],
      [inv(1, "239-DC"), inv(2, "239-DCI2"), inv(3, "239-SBLK")],
    );
    expect(results[0]!.tier).toBe("uncertain");
    expect(results[0]!.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("returns uncertain for a single-edit-distance mismatch", () => {
    const results = classifyEntries(
      [entry("232-DC2")],
      [inv(1, "232-DC3")], // single substitution, distinct stem
    );
    expect(results[0]!.tier).toBe("uncertain");
  });

  it("returns unmatched when nothing is close", () => {
    const results = classifyEntries(
      [entry("ZZZ-9999")],
      [inv(1, "239-DC2"), inv(2, "100")],
    );
    expect(results[0]!.tier).toBe("unmatched");
    expect(results[0]!.candidates).toHaveLength(0);
  });

  it("summarize rolls up tier counts", () => {
    const results = classifyEntries(
      [
        entry("239-DC2"),                // exact
        entry("236-DC2"),                // high-confidence (sibling -DC)
        entry("44-DC"),                  // uncertain (distance 1 vs 40-DC, 41-DC)
        entry("ZZZ-NOPE"),               // unmatched
      ],
      [
        inv(1, "239-DC2"),
        inv(2, "236-DC"),
        inv(3, "40-DC"),
        inv(4, "41-DC"),
      ],
    );
    const s = summarize(results);
    expect(s.total).toBe(4);
    expect(s.exact).toBe(1);
    expect(s.highConfidence).toBe(1);
    expect(s.uncertain).toBe(1);
    expect(s.unmatched).toBe(1);
  });
});
