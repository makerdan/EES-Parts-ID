import {
  parseCatalog,
  parseAmperage,
  parsePoles,
  parseVoltage,
  parseMountType,
  parseTradeSize,
  deriveAttrs,
} from "../src/enrichment/parseAttributes";

// ── parseCatalog ─────────────────────────────────────────────────────────────

describe("parseCatalog – breaker family", () => {
  test("BR120 → 1-pole 20A", () => {
    expect(parseCatalog("BR120")).toEqual({
      series: "BR", poles: 1, amps: 20, variant: null, raw: "BR120", parser_version: 2,
    });
  });

  test("QO220 → 2-pole 20A", () => {
    expect(parseCatalog("QO220")).toEqual({
      series: "QO", poles: 2, amps: 20, variant: null, raw: "QO220", parser_version: 2,
    });
  });

  test("CH3100 → 3-pole 100A", () => {
    expect(parseCatalog("CH3100")).toEqual({
      series: "CH", poles: 3, amps: 100, variant: null, raw: "CH3100", parser_version: 2,
    });
  });

  test("HOM230 → 2-pole 30A", () => {
    expect(parseCatalog("HOM230")).toEqual({
      series: "HOM", poles: 2, amps: 30, variant: null, raw: "HOM230", parser_version: 2,
    });
  });

  test("THQL120 → 1-pole 20A", () => {
    expect(parseCatalog("THQL120")).toEqual({
      series: "THQL", poles: 1, amps: 20, variant: null, raw: "THQL120", parser_version: 2,
    });
  });

  test("QO1100PC → 1-pole 100A variant=PC", () => {
    expect(parseCatalog("QO1100PC")).toEqual({
      series: "QO", poles: 1, amps: 100, variant: "PC", raw: "QO1100PC", parser_version: 2,
    });
  });

  test("BR150 → 1-pole 50A", () => {
    expect(parseCatalog("BR150")).toEqual({
      series: "BR", poles: 1, amps: 50, variant: null, raw: "BR150", parser_version: 2,
    });
  });

  test("MP2020 → 2-pole 20A", () => {
    expect(parseCatalog("MP2020")).toEqual({
      series: "MP", poles: 2, amps: 20, variant: null, raw: "MP2020", parser_version: 2,
    });
  });

  test("lowercase br120 is accepted", () => {
    const r = parseCatalog("br120");
    expect(r?.series).toBe("BR");
    expect(r?.poles).toBe(1);
    expect(r?.amps).toBe(20);
  });

  test("BR4100AF → 4-pole 100A variant=AF", () => {
    expect(parseCatalog("BR4100AF")).toEqual({
      series: "BR", poles: 4, amps: 100, variant: "AF", raw: "BR4100AF", parser_version: 2,
    });
  });
});

describe("parseCatalog – device/receptacle family", () => {
  test("DR15WHI → amps=15 variant=WHI", () => {
    expect(parseCatalog("DR15WHI")).toEqual({
      series: "DR", poles: null, amps: 15, variant: "WHI", raw: "DR15WHI", parser_version: 2,
    });
  });

  test("CR20BLK → amps=20 variant=BLK", () => {
    expect(parseCatalog("CR20BLK")).toEqual({
      series: "CR", poles: null, amps: 20, variant: "BLK", raw: "CR20BLK", parser_version: 2,
    });
  });

  test("TR15 → amps=15 no variant", () => {
    expect(parseCatalog("TR15")).toEqual({
      series: "TR", poles: null, amps: 15, variant: null, raw: "TR15", parser_version: 2,
    });
  });

  test("GF20 → amps=20 GFCI family", () => {
    expect(parseCatalog("GF20")).toEqual({
      series: "GF", poles: null, amps: 20, variant: null, raw: "GF20", parser_version: 2,
    });
  });

  test("WR15 → amps=15 weather-resistant family", () => {
    expect(parseCatalog("WR15")).toMatchObject({
      series: "WR", amps: 15, poles: null,
    });
  });
});

describe("parseCatalog – cable/wire family", () => {
  test("NM214100FT → series=NM", () => {
    const r = parseCatalog("NM214100FT");
    expect(r?.series).toBe("NM");
    expect(r?.poles).toBeNull();
    expect(r?.amps).toBeNull();
    expect(r?.variant).toBe("214100FT");
  });

  test("THHN12 → series=THHN", () => {
    const r = parseCatalog("THHN12");
    expect(r?.series).toBe("THHN");
  });

  test("MC121250FT → series=MC", () => {
    const r = parseCatalog("MC121250FT");
    expect(r?.series).toBe("MC");
  });
});

describe("parseCatalog – transformer family", () => {
  test("V100M50 → transformer", () => {
    const r = parseCatalog("V100M50");
    expect(r?.series).toBe("V100M50");
    expect(r?.poles).toBeNull();
    expect(r?.amps).toBeNull();
    expect(r?.variant).toBeNull();
  });

  test("V500M250T → variant=T", () => {
    const r = parseCatalog("V500M250T");
    expect(r?.series).toBe("V500M250");
    expect(r?.variant).toBe("T");
  });
});

describe("parseCatalog – no-match cases", () => {
  test("returns null for empty string", () => {
    expect(parseCatalog("")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseCatalog(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(parseCatalog(undefined)).toBeNull();
  });

  test("returns null for unrecognized catalog", () => {
    expect(parseCatalog("XYZABC123")).toBeNull();
  });

  test("returns null for purely numeric string", () => {
    expect(parseCatalog("123456")).toBeNull();
  });
});

// ── parseAmperage ────────────────────────────────────────────────────────────

describe("parseAmperage", () => {
  test("20A", () => expect(parseAmperage("20A")).toBe(20));
  test("20 A", () => expect(parseAmperage("20 A")).toBe(20));
  test("20AMP", () => expect(parseAmperage("20AMP")).toBe(20));
  test("20 AMP", () => expect(parseAmperage("20 AMP")).toBe(20));
  test("20 AMPS", () => expect(parseAmperage("20 AMPS")).toBe(20));
  test("20-AMP", () => expect(parseAmperage("20-AMP")).toBe(20));
  test("20 AMPERE", () => expect(parseAmperage("20 AMPERE")).toBe(20));
  test("100 AMPERES", () => expect(parseAmperage("100 AMPERES")).toBe(100));
  test("embedded in description", () =>
    expect(parseAmperage("Single-Pole 20A Circuit Breaker")).toBe(20));
  test("null for empty string", () => expect(parseAmperage("")).toBeNull());
  test("null for no amp pattern", () => expect(parseAmperage("conduit 1/2 inch")).toBeNull());
  test("null for null input", () => expect(parseAmperage(null)).toBeNull());
  test("out of range (0) → null", () => expect(parseAmperage("0A")).toBeNull());
  test("out of range (9999) → null", () => expect(parseAmperage("9999A")).toBeNull());
});

// ── parsePoles ───────────────────────────────────────────────────────────────

describe("parsePoles", () => {
  test("1P", () => expect(parsePoles("1P")).toBe(1));
  test("1-P", () => expect(parsePoles("1-P")).toBe(1));
  test("1 POLE", () => expect(parsePoles("1 POLE")).toBe(1));
  test("SINGLE POLE", () => expect(parsePoles("SINGLE POLE")).toBe(1));
  test("SINGLE-POLE", () => expect(parsePoles("SINGLE-POLE")).toBe(1));
  test("2P", () => expect(parsePoles("2P")).toBe(2));
  test("2 POLE", () => expect(parsePoles("2 POLE")).toBe(2));
  test("DOUBLE POLE", () => expect(parsePoles("DOUBLE POLE")).toBe(2));
  test("DP", () => expect(parsePoles("DP")).toBe(2));
  test("TWO-POLE", () => expect(parsePoles("TWO-POLE")).toBe(2));
  test("3P", () => expect(parsePoles("3P")).toBe(3));
  test("THREE POLE", () => expect(parsePoles("THREE POLE")).toBe(3));
  test("TP", () => expect(parsePoles("TP")).toBe(3));
  test("4P", () => expect(parsePoles("4P")).toBe(4));
  test("FOUR POLE", () => expect(parsePoles("FOUR POLE")).toBe(4));
  test("embedded in description", () =>
    expect(parsePoles("Eaton BR120 Single-Pole 20A Breaker")).toBe(1));
  test("null for unrelated text", () => expect(parsePoles("20A breaker")).toBeNull());
  test("null for empty", () => expect(parsePoles("")).toBeNull());
  test("null for null input", () => expect(parsePoles(null)).toBeNull());
});

// ── parseVoltage ─────────────────────────────────────────────────────────────

describe("parseVoltage", () => {
  test("120V", () => expect(parseVoltage("120V")).toBe(120));
  test("240V", () => expect(parseVoltage("240V")).toBe(240));
  test("277VAC", () => expect(parseVoltage("277VAC")).toBe(277));
  test("480 V", () => expect(parseVoltage("480 V")).toBe(480));
  test("120/240V takes 120 (first match)", () =>
    expect(parseVoltage("120/240V")).toBe(120));
  test("12VDC", () => expect(parseVoltage("12VDC")).toBe(12));
  test("embedded in description", () =>
    expect(parseVoltage("Double-pole 240V circuit breaker")).toBe(240));
  test("null for no voltage pattern", () => expect(parseVoltage("20A breaker")).toBeNull());
  test("null for non-standard voltage (999V)", () =>
    expect(parseVoltage("999V")).toBeNull());
  test("null for null input", () => expect(parseVoltage(null)).toBeNull());
  test("null for empty string", () => expect(parseVoltage("")).toBeNull());
});

// ── parseMountType ───────────────────────────────────────────────────────────

describe("parseMountType", () => {
  test("BOLT-ON", () => expect(parseMountType("BOLT-ON")).toBe("bolt-on"));
  test("bolt on (lowercase)", () => expect(parseMountType("bolt on breaker")).toBe("bolt-on"));
  test("BOLTON (no separator) → null (requires explicit separator)", () =>
    expect(parseMountType("BOLTON")).toBeNull());
  test("PLUG-IN", () => expect(parseMountType("PLUG-IN")).toBe("plug-in"));
  test("plug in (space)", () => expect(parseMountType("plug in breaker")).toBe("plug-in"));
  test("PLUGIN", () => expect(parseMountType("PLUGIN breaker")).toBe("plug-in"));
  test("DIN RAIL", () => expect(parseMountType("DIN RAIL mount")).toBe("din-rail"));
  test("DIN-RAIL", () => expect(parseMountType("DIN-RAIL")).toBe("din-rail"));
  test("SURFACE", () => expect(parseMountType("SURFACE mount")).toBe("surface"));
  test("SURFACE MOUNT", () => expect(parseMountType("SURFACE MOUNT")).toBe("surface"));
  test("FLUSH", () => expect(parseMountType("FLUSH")).toBe("flush"));
  test("FLUSH MOUNT", () => expect(parseMountType("FLUSH MOUNT")).toBe("flush"));
  test("null for null input", () => expect(parseMountType(null)).toBeNull());
  test("null for unrelated text", () =>
    expect(parseMountType("20A single-pole breaker")).toBeNull());
});

// ── deriveAttrs ──────────────────────────────────────────────────────────────

describe("deriveAttrs", () => {
  test("breaker item gets poles and amps from catalog", () => {
    const attrs = deriveAttrs({ catalog: "BR120", description: "1-Pole 20A Breaker" });
    expect(attrs.catalogParse?.series).toBe("BR");
    expect(attrs.amperage).toBe(20);
    expect(attrs.poleCount).toBe(1);
    expect(attrs.attrsParsedAt).toBeInstanceOf(Date);
  });

  test("device item gets amps from catalog, no poles", () => {
    const attrs = deriveAttrs({ catalog: "DR15WHI", description: "15A Duplex Receptacle White" });
    expect(attrs.catalogParse?.series).toBe("DR");
    expect(attrs.amperage).toBe(15);
    expect(attrs.poleCount).toBeNull();
  });

  test("description amp fallback when catalog has no amps", () => {
    const attrs = deriveAttrs({ catalog: "SPECIALITEM", description: "20A special device" });
    expect(attrs.catalogParse).toBeNull();
    expect(attrs.amperage).toBe(20);
  });

  test("voltage extracted from description", () => {
    const attrs = deriveAttrs({ catalog: "BR120", description: "120V Single-Pole Breaker" });
    expect(attrs.voltage).toBe(120);
  });

  test("mount type extracted from description", () => {
    const attrs = deriveAttrs({ catalog: "BR120", description: "Bolt-On 20A breaker" });
    expect(attrs.mountType).toBe("bolt-on");
  });

  test("null catalog is handled gracefully", () => {
    const attrs = deriveAttrs({ catalog: null, description: "20A Device" });
    expect(attrs.catalogParse).toBeNull();
    expect(attrs.amperage).toBe(20);
  });
});

// ── parseCatalog – numeric device family (5xxx / 6xxx) ───────────────────────

describe("parseCatalog – numeric device family", () => {
  test("5262WHI → series=5262 variant=WHI", () => {
    expect(parseCatalog("5262WHI")).toEqual({
      series: "5262", poles: null, amps: null, variant: "WHI", raw: "5262WHI", parser_version: 2,
    });
  });

  test("6150GRY → series=6150 variant=GRY", () => {
    expect(parseCatalog("6150GRY")).toEqual({
      series: "6150", poles: null, amps: null, variant: "GRY", raw: "6150GRY", parser_version: 2,
    });
  });

  test("5262 (no variant) → series=5262 variant=null", () => {
    expect(parseCatalog("5262")).toEqual({
      series: "5262", poles: null, amps: null, variant: null, raw: "5262", parser_version: 2,
    });
  });

  test("5325I → series=5325 variant=I", () => {
    expect(parseCatalog("5325I")).toEqual({
      series: "5325", poles: null, amps: null, variant: "I", raw: "5325I", parser_version: 2,
    });
  });

  test("6200I → series=6200 variant=I", () => {
    expect(parseCatalog("6200I")).toEqual({
      series: "6200", poles: null, amps: null, variant: "I", raw: "6200I", parser_version: 2,
    });
  });

  test("5262-BLK (dash separator) → series=5262 variant=BLK", () => {
    expect(parseCatalog("5262-BLK")).toEqual({
      series: "5262", poles: null, amps: null, variant: "BLK", raw: "5262-BLK", parser_version: 2,
    });
  });

  test("unknown 5-digit catalog 52620 → null (does not match 4-digit rule)", () => {
    expect(parseCatalog("52620")).toBeNull();
  });

  test("catalog not starting with 5 or 6 is not matched", () => {
    expect(parseCatalog("4262WHI")).toBeNull();
  });
});

// ── parseTradeSize ────────────────────────────────────────────────────────────

describe("parseTradeSize – fractions", () => {
  test("1/2\" → 0.5", () => {
    expect(parseTradeSize('1/2"')).toBe(0.5);
  });

  test("3/4 inch → 0.75", () => {
    expect(parseTradeSize("3/4 inch")).toBe(0.75);
  });

  test("1/4 in → 0.25", () => {
    expect(parseTradeSize("1/4 in")).toBe(0.25);
  });

  test("3/8\" → 0.375", () => {
    expect(parseTradeSize('3/8"')).toBe(0.375);
  });

  test("7/8 inches → 0.875", () => {
    expect(parseTradeSize("7/8 inches")).toBe(0.875);
  });
});

describe("parseTradeSize – mixed numbers", () => {
  test("1 1/2\" → 1.5", () => {
    expect(parseTradeSize('1 1/2"')).toBe(1.5);
  });

  test("2-1/2 in → 2.5", () => {
    expect(parseTradeSize("2-1/2 in")).toBe(2.5);
  });

  test("1-1/4\" → 1.25", () => {
    expect(parseTradeSize('1-1/4"')).toBe(1.25);
  });
});

describe("parseTradeSize – decimals and whole numbers", () => {
  test("0.5 in → 0.5", () => {
    expect(parseTradeSize("0.5 in")).toBe(0.5);
  });

  test("2.5\" → 2.5", () => {
    expect(parseTradeSize('2.5"')).toBe(2.5);
  });

  test("2 inch → 2", () => {
    expect(parseTradeSize("2 inch")).toBe(2);
  });

  test("3 in → 3", () => {
    expect(parseTradeSize("3 in")).toBe(3);
  });
});

describe("parseTradeSize – mm conversion", () => {
  test("25mm → ~0.984 inches", () => {
    const result = parseTradeSize("25mm");
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(25 / 25.4, 3);
  });

  test("50 mm → ~1.969 inches", () => {
    const result = parseTradeSize("50 mm");
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(50 / 25.4, 3);
  });
});

describe("parseTradeSize – null / out-of-range cases", () => {
  test("null → null", () => {
    expect(parseTradeSize(null)).toBeNull();
  });

  test("empty string → null", () => {
    expect(parseTradeSize("")).toBeNull();
  });

  test("plain description with no size → null", () => {
    expect(parseTradeSize("circuit breaker 20A")).toBeNull();
  });

  test("value over 12 inches is rejected", () => {
    expect(parseTradeSize('24"')).toBeNull();
  });

  test("zero is rejected", () => {
    expect(parseTradeSize('0"')).toBeNull();
  });

  test("1000mm (≫ 12\") is rejected", () => {
    expect(parseTradeSize("1000mm")).toBeNull();
  });
});
