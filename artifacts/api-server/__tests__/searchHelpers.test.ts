import {
  normalizeMeasurement,
  parseCatalogNumber,
  correctMisspelling,
  extractSizeValue,
  compareBySize,
  getSeriesBase,
  itemFullText,
  tokenMatch,
  matchesChipFilters,
  buildChipFilterRegexes,
} from "../src/utils/searchHelpers";

// ── normalizeMeasurement ──────────────────────────────────────────────────────

describe("normalizeMeasurement", () => {
  it("converts written fraction words to numeric fractions", () => {
    expect(normalizeMeasurement("one-half inch conduit")).toContain("1/2");
    expect(normalizeMeasurement("three-quarter conduit")).toContain("3/4");
    expect(normalizeMeasurement("one-quarter inch")).toContain("1/4");
  });

  it("converts written compound fractions", () => {
    expect(normalizeMeasurement("two-and-a-half inch")).toContain("2-1/2");
    expect(normalizeMeasurement("one-and-a-half conduit")).toContain("1-1/2");
    expect(normalizeMeasurement("one-and-a-quarter pipe")).toContain("1-1/4");
  });

  it("converts decimal inch notation to fractional", () => {
    expect(normalizeMeasurement("0.5in conduit")).toContain("1/2");
    expect(normalizeMeasurement("0.75in conduit")).toContain("3/4");
    expect(normalizeMeasurement("0.25in conduit")).toContain("1/4");
  });

  it("converts the word 'inches' to double-quote symbol", () => {
    expect(normalizeMeasurement("4 inches EMT")).toContain('4 "');
  });

  it("lowercases the entire string", () => {
    expect(normalizeMeasurement("BREAKER")).toBe("breaker");
  });

  it("returns unchanged strings that have no measurement patterns", () => {
    const input = "20a circuit breaker";
    expect(normalizeMeasurement(input)).toBe(input);
  });
});

// ── parseCatalogNumber ────────────────────────────────────────────────────────

describe("parseCatalogNumber", () => {
  it("parses single-pole breaker catalog numbers", () => {
    const terms = parseCatalogNumber("BR120");
    expect(terms).toContain("BR");
    expect(terms).toContain("20a");
    expect(terms).toContain("20amp");
    expect(terms.some(t => /single pole/i.test(t))).toBe(true);
  });

  it("parses two-pole breaker catalog numbers", () => {
    const terms = parseCatalogNumber("QO220");
    expect(terms).toContain("QO");
    expect(terms.some(t => /double pole/i.test(t))).toBe(true);
    expect(terms).toContain("20a");
  });

  it("parses Square D QO2020 (two 20A)", () => {
    const terms = parseCatalogNumber("QO2020");
    expect(terms).toContain("QO");
  });

  it("parses wire gauge fraction patterns", () => {
    const terms = parseCatalogNumber("12/2");
    expect(terms).toContain("12/2");
    expect(terms).toContain("12 awg");
    expect(terms).toContain("2 conductor");
  });

  it("parses 14/3 with 3 conductor label", () => {
    const terms = parseCatalogNumber("14/3");
    expect(terms).toContain("3 conductor");
    expect(terms).toContain("14 awg");
  });

  it("parses receptacle catalog with color suffix", () => {
    const terms = parseCatalogNumber("DR15WHI");
    expect(terms).toContain("15a");
    expect(terms).toContain("receptacle");
    expect(terms).toContain("outlet");
    expect(terms).toContain("white");
  });

  it("parses transformer voltage pattern", () => {
    const terms = parseCatalogNumber("V120M500");
    expect(terms).toContain("transformer");
    expect(terms).toContain("120v");
    expect(terms).toContain("500va");
  });

  it("parses conduit size from catalog prefix", () => {
    const terms = parseCatalogNumber("2EMT");
    expect(terms).toContain("2 inch");
    expect(terms).toContain("emt");
    expect(terms).toContain("conduit");
  });

  it("parses aught wire notation (0000 = 4/0)", () => {
    const terms = parseCatalogNumber("0000");
    expect(terms).toContain("4/0");
    expect(terms).toContain("4 aught");
  });

  it("returns empty array for unrecognized catalog with no digits", () => {
    const terms = parseCatalogNumber("MISC");
    expect(Array.isArray(terms)).toBe(true);
  });
});

// ── correctMisspelling ────────────────────────────────────────────────────────

describe("correctMisspelling", () => {
  it("returns the corrected spelling from the map", () => {
    const map = new Map([["breker", "breaker"], ["recptacle", "receptacle"]]);
    expect(correctMisspelling("breker", map)).toBe("breaker");
    expect(correctMisspelling("RECPTACLE", map)).toBe("receptacle");
  });

  it("returns the original word when not in the map", () => {
    const map = new Map([["breker", "breaker"]]);
    expect(correctMisspelling("switch", map)).toBe("switch");
  });

  it("is case-insensitive on the lookup key", () => {
    const map = new Map([["breker", "breaker"]]);
    expect(correctMisspelling("BREKER", map)).toBe("breaker");
  });

  it("returns original casing for unknown words", () => {
    const map = new Map<string, string>();
    expect(correctMisspelling("Receptacle", map)).toBe("Receptacle");
  });
});

// ── extractSizeValue ──────────────────────────────────────────────────────────

describe("extractSizeValue", () => {
  const item = (catalog: string, description: string) => ({ catalog, description });

  it("extracts amperage value", () => {
    expect(extractSizeValue(item("BR120", "20A single-pole breaker"))).toBe(20);
  });

  it("extracts AWG gauge as inverted sort key", () => {
    // #14 AWG → 88 - 14 = 74; thicker wire (#12) → 76 (sorts higher)
    expect(extractSizeValue(item("THHN", "14 AWG wire"))).toBe(74);
    expect(extractSizeValue(item("THHN", "12 AWG wire"))).toBe(76);
  });

  it("extracts mixed fraction sizes (1-1/2)", () => {
    expect(extractSizeValue(item("EMT", "1-1/2 conduit"))).toBeCloseTo(1.5);
  });

  it("extracts simple fraction sizes (3/4)", () => {
    expect(extractSizeValue(item("EMT", "3/4 conduit"))).toBeCloseTo(0.75);
  });

  it("extracts decimal sizes", () => {
    expect(extractSizeValue(item("PVC", "2.5 conduit"))).toBeCloseTo(2.5);
  });

  it("extracts foot lengths when no higher-priority pattern matches", () => {
    expect(extractSizeValue(item("THHN", "250FT spool"))).toBe(250);
  });

  it("extracts wattage", () => {
    expect(extractSizeValue(item("LED100W", "100W LED bulb"))).toBe(100);
  });

  it("returns null when no size pattern is recognized", () => {
    expect(extractSizeValue(item("MISC", "general hardware"))).toBeNull();
  });
});

// ── compareBySize ────────────────────────────────────────────────────────────

describe("compareBySize", () => {
  const item = (catalog: string, description: string) => ({ catalog, description });

  it("sorts items with detectable sizes ascending", () => {
    const items = [
      item("EMT", "1 conduit"),
      item("EMT", "1/2 conduit"),
      item("EMT", "3/4 conduit"),
    ];
    items.sort(compareBySize);
    expect(items.map(i => i.description)).toEqual([
      "1/2 conduit",
      "3/4 conduit",
      "1 conduit",
    ]);
  });

  it("sends untyped items to the end of the list, never interleaved", () => {
    // Use unambiguous typed sizes (amperage, fraction) so the test does not
    // depend on the parser's looser fallbacks.
    const items = [
      item("MISC", "no size here"),       // null
      item("BR120", "20A breaker"),       // 20 (amp)
      item("EMT", "1/2 conduit"),         // 0.5 (frac)
      item("RANDOM", "another untyped"),  // null
    ];
    items.sort(compareBySize);
    // Typed items first (1/2 = 0.5 < 20), untyped land at the end together.
    expect(extractSizeValue(items[0]!)).not.toBeNull();
    expect(extractSizeValue(items[1]!)).not.toBeNull();
    expect(extractSizeValue(items[2]!)).toBeNull();
    expect(extractSizeValue(items[3]!)).toBeNull();
  });

  it("treats two untyped items as equal", () => {
    expect(compareBySize(item("X", "x"), item("Y", "y"))).toBe(0);
  });
});

// ── getSeriesBase ─────────────────────────────────────────────────────────────

describe("getSeriesBase", () => {
  it("groups breakers by series", () => {
    const result = getSeriesBase("Eaton", "BR120", "20A breaker");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("OTHER AMPERAGES");
    expect(result!.key).toContain("EATON");
    expect(result!.key).toContain("BR");
  });

  it("groups receptacles by color/type", () => {
    const result = getSeriesBase("Hubbell", "DR15WHI", "15A receptacle");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("OTHER COLORS");
  });

  it("groups wires by length", () => {
    const result = getSeriesBase("Southwire", "NM12/2-250FT", "NM-B 12/2 250ft");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("OTHER LENGTHS");
  });

  it("groups transformers by capacity", () => {
    const result = getSeriesBase("Acme", "V120M500T1PH", "transformer");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("OTHER CAPACITIES");
  });

  it("groups conduit by size when catalog itself starts with size + conduit type", () => {
    const result = getSeriesBase("Allied", "2EMT", "2 inch EMT conduit");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("OTHER SIZES");
  });

  it("does NOT collapse non-conduit catalogs whose description merely mentions conduit", () => {
    // A fitting whose description references EMT but whose catalog isn't a
    // size-prefixed conduit code should not be grouped under OTHER SIZES.
    const result = getSeriesBase(
      "Vendor",
      "FITTING-XYZ-9988",
      "Connector for use with EMT conduit",
    );
    expect(result).toBeNull();
  });

  it("returns null for unrecognised catalog patterns", () => {
    const result = getSeriesBase("Vendor", "MISC123", "miscellaneous item");
    expect(result).toBeNull();
  });
});

// ── buildChipFilterRegexes ───────────────────────────────────────────────────

describe("buildChipFilterRegexes", () => {
  it("returns one boundary regex per token in each filter value", () => {
    const out = buildChipFilterRegexes([
      { key: "amperage", value: "20a" },
      { key: "poleCount", value: "single pole" },
    ]);
    expect(out).toEqual([
      "(^|[^[:alnum:]_])20a($|[^[:alnum:]_])",
      "(^|[^[:alnum:]_])single($|[^[:alnum:]_])",
      "(^|[^[:alnum:]_])pole($|[^[:alnum:]_])",
    ]);
  });

  it("uses non-alphanumeric boundaries (not Postgres \\m/\\M) so punctuation-leading tokens work", () => {
    // `\m` / `\M` only fire at word-character transitions. Tokens that start
    // or end with non-word chars (`#14`, `1/2"`) would never match `\m`/`\M`
    // even when surrounded by whitespace; the boundary alternation here does.
    const out = buildChipFilterRegexes([
      { key: "wireGauge", value: "#14" },
      { key: "sizeChip", value: '1/2"' },
    ]);
    expect(out).toEqual([
      "(^|[^[:alnum:]_])#14($|[^[:alnum:]_])",
      '(^|[^[:alnum:]_])1/2"($|[^[:alnum:]_])',
    ]);
  });

  it("escapes a literal dot inside a filter value", () => {
    const out = buildChipFilterRegexes([{ key: "size", value: "1.5" }]);
    expect(out).toEqual(["(^|[^[:alnum:]_])1\\.5($|[^[:alnum:]_])"]);
  });

  it("escapes regex metacharacters that would otherwise alter matching", () => {
    const out = buildChipFilterRegexes([{ key: "k", value: "a+b*c?(d)" }]);
    expect(out).toEqual([
      "(^|[^[:alnum:]_])a\\+b\\*c\\?\\(d\\)($|[^[:alnum:]_])",
    ]);
  });

  it("skips empty values and trims whitespace", () => {
    const out = buildChipFilterRegexes([
      { key: "a", value: "" },
      { key: "b", value: "  " },
      { key: "c", value: "  red  " },
    ]);
    expect(out).toEqual(["(^|[^[:alnum:]_])red($|[^[:alnum:]_])"]);
  });

  it("returns an empty array when given no filters", () => {
    expect(buildChipFilterRegexes([])).toEqual([]);
  });
});

// ── itemFullText ──────────────────────────────────────────────────────────────

describe("itemFullText", () => {
  it("concatenates vendor, catalog, description, and aiKeywords", () => {
    const text = itemFullText({
      vendor: "Eaton",
      catalog: "BR120",
      description: "20A breaker",
      aiKeywords: ["single pole", "residential"],
    });
    expect(text).toContain("eaton");
    expect(text).toContain("br120");
    expect(text).toContain("20a breaker");
    expect(text).toContain("single pole");
    expect(text).toContain("residential");
  });

  it("handles null aiKeywords without throwing", () => {
    const text = itemFullText({
      vendor: "Hubbell",
      catalog: "DR15",
      description: "15A receptacle",
      aiKeywords: null,
    });
    expect(text).toContain("hubbell");
    expect(text).toContain("dr15");
  });

  it("returns all text in lowercase", () => {
    const text = itemFullText({
      vendor: "EATON",
      catalog: "BR120",
      description: "20A BREAKER",
      aiKeywords: ["SINGLE POLE"],
    });
    expect(text).toBe(text.toLowerCase());
  });
});

// ── tokenMatch ────────────────────────────────────────────────────────────────

describe("tokenMatch", () => {
  it("matches when the filter token appears as a whole word", () => {
    expect(tokenMatch("20a single pole breaker", "breaker")).toBe(true);
    expect(tokenMatch("20a single pole breaker", "20a")).toBe(true);
  });

  it("does not match when the token appears only as a substring", () => {
    // "20" should not match inside "200a"
    expect(tokenMatch("200a double pole breaker", "20")).toBe(false);
  });

  it("matches multi-token filter values (AND logic)", () => {
    expect(tokenMatch("20a single pole breaker eaton", "single pole")).toBe(true);
    expect(tokenMatch("20a double pole breaker eaton", "single pole")).toBe(false);
  });

  it("returns true for an empty filter value", () => {
    expect(tokenMatch("anything", "")).toBe(true);
    expect(tokenMatch("anything", "  ")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(tokenMatch("eaton br120 breaker", "BREAKER")).toBe(true);
    expect(tokenMatch("EATON BR120 BREAKER", "breaker")).toBe(true);
  });

  it("handles filter tokens with regex special characters (e.g. '1/2\"')", () => {
    expect(tokenMatch('3/4" emt conduit', '3/4"')).toBe(true);
    expect(tokenMatch('1/2" emt conduit', '3/4"')).toBe(false);
  });

  it("matches size codes within a description", () => {
    expect(tokenMatch("1-1/2 inch emt conduit fitting", "1-1/2")).toBe(true);
  });
});

// ── matchesChipFilters ────────────────────────────────────────────────────────

describe("matchesChipFilters", () => {
  const item = (description: string) => ({
    vendor: "Eaton",
    catalog: "BR120",
    description,
    aiKeywords: null,
  });

  it("returns true when all chip filters match", () => {
    const result = matchesChipFilters(item("20a single pole breaker white"), [
      { key: "amperage", value: "20a" },
      { key: "poleCount", value: "single pole" },
    ]);
    expect(result).toBe(true);
  });

  it("returns false when any chip filter does not match", () => {
    const result = matchesChipFilters(item("20a single pole breaker"), [
      { key: "amperage", value: "20a" },
      { key: "colorChip", value: "Red" },
    ]);
    expect(result).toBe(false);
  });

  it("returns true with an empty filter array", () => {
    expect(matchesChipFilters(item("any description"), [])).toBe(true);
  });

  it("uses aiKeywords in the match text when provided", () => {
    const itemWithKw = {
      vendor: "Eaton",
      catalog: "BR120",
      description: "breaker",
      aiKeywords: ["residential", "loadcenter"],
    };
    const result = matchesChipFilters(itemWithKw, [
      { key: "misc", value: "loadcenter" },
    ]);
    expect(result).toBe(true);
  });
});
