/**
 * @jest-environment node
 *
 * Verifies that the Fuse.js index configuration used by the Search screen
 * correctly expands abbreviations, synonyms, and slang through the
 * `aiKeywords` field, widening search results beyond what the core
 * description/catalog/vendor text alone would return.
 *
 * These tests instantiate Fuse directly with the same options used in
 * index.tsx so they pin the field weights, threshold, and flags without
 * depending on a React component tree.
 *
 * Covered scenarios
 * ─────────────────
 *  1. Abbreviation match — "CB" → item whose aiKeywords includes "CB"
 *  2. Synonym match — "breaker" → item with aiKeyword "circuit breaker"
 *  3. Slang/common-name match — "pigtail" → item described as "wire connector"
 *  4. aiKeywords widens results beyond description — item NOT found by catalog
 *     or description alone IS found via aiKeywords
 *  5. Fuse catalog weight — exact catalog number returns item first
 *  6. Description weight — descriptive keyword returns the right item
 *  7. Vendor weight — vendor name match returns item
 *  8. High-confidence threshold filters noise — very unrelated query returns nothing
 *  9. Multiple aiKeyword expansions on one item — all synonyms match
 * 10. Multi-term query — two space-separated keywords narrow results correctly
 */

import Fuse, { type IFuseOptions, type FuseResult } from "fuse.js";

// ── Fuse config mirrored from app/(tabs)/index.tsx ────────────────────────────

function fuseOptions<T>(): IFuseOptions<T> {
  return {
    keys: [
      { name: "catalog",     weight: 0.35 },
      { name: "description", weight: 0.30 },
      { name: "vendor",      weight: 0.10 },
      { name: "aiKeywords",  weight: 0.25 },
    ],
    threshold: 0.45,
    ignoreLocation: true,
    minMatchCharLength: 2,
    findAllMatches: true,
    includeScore: true,
  };
}

// ── Minimal item shape ────────────────────────────────────────────────────────

type TestItem = {
  id: number;
  catalog: string;
  description: string;
  vendor: string;
  aiKeywords: string[];
};

function makeItem(
  id: number,
  catalog: string,
  description: string,
  vendor = "TestVendor",
  aiKeywords: string[] = [],
): TestItem {
  return { id, catalog, description, vendor, aiKeywords };
}

function buildIndex(items: TestItem[]) {
  return new Fuse(items, fuseOptions<TestItem>());
}

function ids(results: FuseResult<TestItem>[]): number[] {
  return results.map(r => r.item.id);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Fuse aiKeywords expansion — abbreviations, synonyms, slang", () => {
  it("finds an item by its abbreviated aiKeyword (CB → circuit breaker)", () => {
    const items = [
      makeItem(1, "QO120", "Single-pole circuit breaker", "Square D", ["CB", "circuit breaker", "breaker"]),
      makeItem(2, "MC10", "Motor contactor", "ABB", []),
    ];
    const fuse = buildIndex(items);
    const results = fuse.search("CB");
    expect(ids(results)).toContain(1);
    expect(ids(results)).not.toContain(2);
  });

  it("finds an item by synonym in aiKeywords (breaker → circuit breaker)", () => {
    const items = [
      makeItem(10, "QO220", "Tandem two-pole AFCI", "Square D", ["circuit breaker", "breaker", "AFCI"]),
      makeItem(11, "WIRE12", "12 AWG THHN wire", "Southwire", ["wire", "THHN"]),
    ];
    const fuse = buildIndex(items);
    const results = fuse.search("breaker");
    expect(ids(results)).toContain(10);
    expect(ids(results)).not.toContain(11);
  });

  it("finds an item by common slang when it appears in aiKeywords (pigtail → wire connector)", () => {
    const items = [
      makeItem(20, "CONN-8", "8-port wire connector", "Ideal", ["pigtail", "wire nut", "connector"]),
      makeItem(21, "PVC-1", '1" PVC conduit', "Carlon", ["conduit", "pipe"]),
    ];
    const fuse = buildIndex(items);
    const results = fuse.search("pigtail");
    expect(ids(results)).toContain(20);
  });

  it("widens results — item NOT matchable by description alone IS found via aiKeywords", () => {
    // Item has a cryptic catalog/description but useful aiKeywords
    const items = [
      makeItem(30, "XC-4481", "Device assembly — type 4", "Acme", ["duplex outlet", "receptacle", "15A outlet"]),
      makeItem(31, "XC-4482", "Device assembly — type 5", "Acme", []),
    ];
    const fuse = buildIndex(items);
    const plain = buildIndex([makeItem(30, "XC-4481", "Device assembly — type 4", "Acme", [])]);

    // Without aiKeywords the item is NOT found by "outlet"
    expect(plain.search("outlet").length).toBe(0);

    // With aiKeywords it IS found
    const expanded = fuse.search("outlet");
    expect(ids(expanded)).toContain(30);
    expect(ids(expanded)).not.toContain(31);
  });

  it("catalog weight — exact catalog number returns the correct item at the top", () => {
    const items = [
      makeItem(40, "QO115", "15A single-pole breaker", "Square D", ["CB"]),
      makeItem(41, "QO120", "20A single-pole breaker", "Square D", ["CB"]),
      makeItem(42, "QO130", "30A single-pole breaker", "Square D", ["CB"]),
    ];
    const fuse = buildIndex(items);
    const results = fuse.search("QO120");
    expect(results[0]!.item.id).toBe(41);
  });

  it("description weight — descriptive keyword returns the right item", () => {
    const items = [
      makeItem(50, "BRK-50", "GFCI outlet receptacle", "Leviton", ["GFCI", "ground fault"]),
      makeItem(51, "BRK-51", "Standard duplex outlet", "Leviton", ["duplex"]),
    ];
    const fuse = buildIndex(items);
    const results = fuse.search("GFCI");
    expect(ids(results)).toContain(50);
  });

  it("vendor weight — vendor name match returns the item", () => {
    const items = [
      makeItem(60, "HBL5266C", "Straight-blade plug 15A", "Hubbell", []),
      makeItem(61, "L630P", "Twist-lock plug 30A", "Leviton", []),
    ];
    const fuse = buildIndex(items);
    const results = fuse.search("Hubbell");
    expect(ids(results)).toContain(60);
  });

  it("unrelated query returns no results (threshold filters noise)", () => {
    const items = [
      makeItem(70, "EMT34", '3/4" EMT conduit', "Allied", ["conduit", "EMT"]),
      makeItem(71, "LB34", '3/4" LB fitting', "Raco", ["fitting", "LB conduit body"]),
    ];
    const fuse = buildIndex(items);
    // A completely unrelated query should score too poorly to pass the threshold
    const results = fuse.search("refrigerator");
    expect(results).toHaveLength(0);
  });

  it("multiple aiKeyword synonyms on one item — all synonyms match individually", () => {
    const item = makeItem(80, "CONN-NUT", "Wire connector", "Ideal", [
      "wire nut", "marrette", "twist connector", "pigtail",
    ]);
    const fuse = buildIndex([item]);
    expect(fuse.search("wire nut").length).toBeGreaterThan(0);
    expect(fuse.search("marrette").length).toBeGreaterThan(0);
    expect(fuse.search("pigtail").length).toBeGreaterThan(0);
  });

  it("multi-term query narrows results to the most relevant item", () => {
    const items = [
      makeItem(90, "QO130AF", "30A AFCI breaker", "Square D", ["AFCI", "arc fault", "arc fault breaker"]),
      makeItem(91, "QO130GF", "30A GFCI breaker", "Square D", ["GFCI", "ground fault"]),
      makeItem(92, "QO115",   "15A breaker",       "Square D", ["CB", "breaker"]),
    ];
    const fuse = buildIndex(items);
    const results = fuse.search("AFCI breaker");
    // Item 90 must appear and be ranked above items 91 and 92
    expect(ids(results)).toContain(90);
    expect(results[0]!.item.id).toBe(90);
  });
});
