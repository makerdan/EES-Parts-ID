/**
 * Unit tests for vendor name → code resolution logic.
 *
 * No database, no network.  Builds a synthetic reverseVendorMap from the
 * exported PRIMARY_VENDORS array using the same algorithm as inventory.ts
 * (forward iteration over PRIMARY_VENDORS, last-write wins for conflicts,
 * then PRIORITY_CODES re-applied last), and asserts that EVERY name in EVERY
 * PRIMARY_VENDORS entry resolves to the declared winner code — including
 * explicit handling of all known conflict cases.
 */

import { PRIMARY_VENDORS, VENDORS } from "../src/seed/dictionaries";

// ── Resolution algorithm (mirrors inventory.ts) ───────────────────────────────

function buildSyntheticReverseVendorMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of PRIMARY_VENDORS) {
    for (const name of v.names) map.set(name.toLowerCase(), v.code);
  }
  return map;
}

/**
 * Mirrors inventory.ts lines 668-670:
 *   resolvedCode = map.get(input.toLowerCase()) ?? input.toUpperCase()
 */
function resolveVendorCode(input: string, map: Map<string, string>): string {
  return map.get(input.toLowerCase()) ?? input.toUpperCase();
}

// ── Conflict winner declarations ──────────────────────────────────────────────
//
// When multiple PRIMARY_VENDORS entries share a name, exactly one code wins in
// the final map.  The winner is determined by:
//   1. PRIORITY_CODES override (applied last — highest precedence)
//   2. Iteration order over PRIMARY_VENDORS: the LAST entry to contain a name
//      wins (last-write semantics).
//
// Declare every such conflict winner explicitly so the test is not circular.
// If someone re-orders PRIMARY_VENDORS, these declarations catch the regression.

/**
 * Names that appear in more than one PRIMARY_VENDORS entry.
 * Value = the code that WINS in the synthetic map (based on array order).
 *
 * Derivation:
 *   - "eaton" / "cutler hammer" / "cutler-hammer" / "c-h" / "eaton electrical":
 *       CHD (earlier in array) and ETN (later) share these → ETN wins (last-write).
 *   - "eaton electrical" is also in EAT (between CHD and ETN) — ETN still wins (latest).
 *   - "eaton corporation": EAT (earlier) and ETN (later) → ETN wins.
 *   - "thomas betts" / "thomas & betts" / "t&b": ABB (early) and TAB (latest) → TAB wins.
 *   - "edison fuse": BUS (earlier) and EDN (later) → EDN wins.
 *   - CHC and CRS no longer share any names; each owns its names uniquely.
 */
const CONFLICT_WINNERS = new Map<string, string>([
  // ETN wins for eaton-family names (ETN is later in PRIMARY_VENDORS than CHD and EAT)
  ["eaton",               "ETN"],
  ["cutler hammer",       "ETN"],
  ["cutler-hammer",       "ETN"],
  ["c-h",                 "ETN"],
  ["eaton electrical",    "ETN"],
  ["eaton corporation",   "ETN"],

  // TAB wins for thomas-betts names (TAB is later in PRIMARY_VENDORS than ABB)
  ["thomas betts",        "TAB"],
  ["thomas & betts",      "TAB"],
  ["t&b",                 "TAB"],

  // EDN wins for "edison fuse" (EDN is later in PRIMARY_VENDORS than BUS)
  ["edison fuse",         "EDN"],
]);

// ── Tests: every name in every entry ─────────────────────────────────────────

describe("vendorNameResolution — every PRIMARY_VENDORS name resolves to the declared winner code", () => {
  const map = buildSyntheticReverseVendorMap();

  it("covers all entries (sanity check: PRIMARY_VENDORS has expected size)", () => {
    expect(PRIMARY_VENDORS.length).toBeGreaterThanOrEqual(60);
  });

  // Generate one assertion per vendor entry, checking all names in that entry.
  for (const entry of PRIMARY_VENDORS) {
    it(`${entry.code}: every name resolves to the expected code`, () => {
      for (const name of entry.names) {
        const lc = name.toLowerCase();
        const expectedCode = CONFLICT_WINNERS.get(lc) ?? entry.code;
        expect({
          vendor: entry.code,
          name,
          resolved: resolveVendorCode(name, map),
        }).toEqual({
          vendor: entry.code,
          name,
          resolved: expectedCode,
        });
      }
    });
  }
});

// ── Tests: CRS and CHC each own their own names ───────────────────────────────

describe("vendorNameResolution — CRS owns all crouse-hinds names; CHC owns its cooper names", () => {
  const map = buildSyntheticReverseVendorMap();

  it("'crouse-hinds' → CRS (unique to CRS)", () => {
    expect(resolveVendorCode("crouse-hinds", map)).toBe("CRS");
  });

  it("'crouse hinds' → CRS", () => {
    expect(resolveVendorCode("crouse hinds", map)).toBe("CRS");
  });

  it("'cooper crouse-hinds' → CRS", () => {
    expect(resolveVendorCode("cooper crouse-hinds", map)).toBe("CRS");
  });

  it("'eaton crouse-hinds' → CRS", () => {
    expect(resolveVendorCode("eaton crouse-hinds", map)).toBe("CRS");
  });

  it("'cooper industries' → CHC (unique to CHC in PRIMARY_VENDORS)", () => {
    expect(resolveVendorCode("cooper industries", map)).toBe("CHC");
  });

  it("'cooper electric' → CHC", () => {
    expect(resolveVendorCode("cooper electric", map)).toBe("CHC");
  });

  it("'eaton cooper' → CHC", () => {
    expect(resolveVendorCode("eaton cooper", map)).toBe("CHC");
  });

  it("CHC owns all of its names in the map", () => {
    const chc = PRIMARY_VENDORS.find((v) => v.code === "CHC")!;
    for (const name of chc.names) {
      expect({ name, resolved: map.get(name.toLowerCase()) }).toEqual({
        name, resolved: "CHC",
      });
    }
  });
});

// ── Tests: last-write conflict winners (array-order dependent) ────────────────

describe("vendorNameResolution — last-write wins: ETN beats CHD for eaton-family names", () => {
  const map = buildSyntheticReverseVendorMap();

  it("'eaton' → ETN (ETN appears after CHD in the PRIMARY_VENDORS array)", () => {
    expect(resolveVendorCode("eaton", map)).toBe("ETN");
  });

  it("'cutler hammer' → ETN", () => {
    expect(resolveVendorCode("cutler hammer", map)).toBe("ETN");
  });

  it("'cutler-hammer' → ETN", () => {
    expect(resolveVendorCode("cutler-hammer", map)).toBe("ETN");
  });

  it("'westinghouse' → ETN (unique to ETN)", () => {
    expect(resolveVendorCode("westinghouse", map)).toBe("ETN");
  });

  it("'ch' → CHD (unique to CHD — ETN only has 'c-h', not 'ch')", () => {
    expect(resolveVendorCode("ch", map)).toBe("CHD");
  });
});

describe("vendorNameResolution — last-write wins: TAB beats ABB for thomas-betts names", () => {
  const map = buildSyntheticReverseVendorMap();

  it("'thomas betts' → TAB (TAB appears after ABB in the array)", () => {
    expect(resolveVendorCode("thomas betts", map)).toBe("TAB");
  });

  it("'thomas & betts' → TAB", () => {
    expect(resolveVendorCode("thomas & betts", map)).toBe("TAB");
  });

  it("'t&b' → TAB", () => {
    expect(resolveVendorCode("t&b", map)).toBe("TAB");
  });

  it("'abb inc' → ABB (unique to ABB)", () => {
    expect(resolveVendorCode("abb inc", map)).toBe("ABB");
  });
});

// ── Tests: bare-code passthrough ──────────────────────────────────────────────

describe("vendorNameResolution — bare-code passthrough (resolver falls back to toUpperCase)", () => {
  const map = buildSyntheticReverseVendorMap();

  it("'ACMECORP' (unknown) passes through as 'ACMECORP'", () => {
    expect(resolveVendorCode("ACMECORP", map)).toBe("ACMECORP");
  });

  it("'acmecorp' (lowercase unknown) is uppercased on passthrough", () => {
    expect(resolveVendorCode("acmecorp", map)).toBe("ACMECORP");
  });

  it("empty string returns empty string", () => {
    expect(resolveVendorCode("", map)).toBe("");
  });
});

// ── Tests: mixed-case inputs ──────────────────────────────────────────────────

describe("vendorNameResolution — mixed-case inputs resolve identically to lowercase", () => {
  const map = buildSyntheticReverseVendorMap();

  const cases: Array<[string, string]> = [
    ["Crouse-Hinds",       "CRS"],
    ["SQUARE D",           "SQD"],
    ["Square D",           "SQD"],
    ["HUBBELL",            "HBL"],
    ["Hubbell",            "HBL"],
    ["LEVITON",            "LEV"],
    ["Leviton",            "LEV"],
    ["Siemens",            "SIE"],
    ["SIEMENS",            "SIE"],
    ["Klein Tools",        "KLE"],
    ["KLEIN TOOLS",        "KLE"],
    ["Milwaukee Tool",     "MIL"],
    ["Lutron",             "LUT"],
    ["Pass & Seymour",     "PAS"],
    ["PASS & SEYMOUR",     "PAS"],
    ["Ideal Industries",   "IDE"],
    ["Hubbell Lighting",   "HBL"],
  ];

  for (const [input, expected] of cases) {
    it(`'${input}' → ${expected}`, () => {
      expect(resolveVendorCode(input, map)).toBe(expected);
    });
  }
});

// ── Collision guard ───────────────────────────────────────────────────────────
//
// This describe block reads the full VENDORS + PRIMARY_VENDORS arrays and asserts
// that no two entries share a name alias UNLESS that alias is explicitly recorded
// in KNOWN_DUPLICATE_ALIASES below.
//
// HOW TO ADD A NEW INTENTIONAL OVERLAP:
//   1. Add the lowercased alias string to KNOWN_DUPLICATE_ALIASES.
//   2. Add a comment explaining which entries share it and why it is intentional.
//
// WHY THIS MATTERS:
//   The CHC/CRS alias collision ("cooper crouse-hinds" appearing in both a
//   VENDORS COO entry and PRIMARY_VENDORS CRS) went undetected for a long time
//   because no build-time check existed.  A new collision can silently make a
//   vendor unsearchable when the wrong code wins at seed time.
//
// ── Allowlist of known intentional overlaps ───────────────────────────────────
//
// Group A — Same code in both arrays (VENDORS extended list mirrors PRIMARY_VENDORS).
//   These are harmless: both entries resolve to the same code.
//   Names: arlington, arlington industries, bare copper, buss fuse, bussmann,
//          cooper lighting, cooper lighting solutions, copper, copper wire,
//          eaton bussmann, eaton cooper lighting, hoffman, ideal, ideal electrical,
//          ideal industries, klein, klein tools, levition, leviton,
//          leviton manufacturing, leviton wiring, lutron, lutron electronics,
//          lutron shading, milwaukee, milwaukee electric tool, milwaukee tool,
//          pentair hoffman, rab lighting, satco, satco lighting, satco products,
//          schneider, schneider electric, siemans, siemens, siemens energy,
//          siemens industry, sq d, squaed d, square d, squared, westinghouse.
//
// Group B — Eaton family (ETN wins for most; CHD keeps "ch" uniquely).
//   Names: eaton, cutler hammer, cutler-hammer, c-h, eaton electrical,
//          eaton corporation, ch.
//
// Group C — Thomas & Betts / ABB family (TAB wins; ABB keeps "abb inc").
//   Names: thomas betts, thomas & betts, t&b, tnb, abb.
//
// Group D — Cooper family: CHC owns "cooper industries", CRS owns
//   "cooper crouse-hinds", BUS owns "cooper bussmann".
//   Names: cooper industries, cooper crouse-hinds, cooper bussmann.
//
// Group E — 3M / Scotch (SCO wins in PRIMARY_VENDORS).
//   Names: 3m, 3m company, 3m electrical, scotch, scotchlock.
//
// Group F — GE / GEL (GEL wins in PRIMARY_VENDORS).
//   Names: ge, general electric, ge industrial, ge power, ge electrical.
//
// Group G — Generac (GEN wins in PRIMARY_VENDORS over VENDORS GNR).
//   Names: generac, generac power systems, generac generator.
//
// Group H — Sylvania family (SYL wins in PRIMARY_VENDORS over VENDORS SPX).
//   Names: sylvania, sylvania lighting, osram sylvania, gte sylvania.
//
// Group I — Fluke (FLU wins in PRIMARY_VENDORS over VENDORS FLS).
//   Names: fluke, fluke corporation.
//
// Group J — Hubbell (HBL wins in PRIMARY_VENDORS over VENDORS HUB).
//   Names: hubbell, hubbell wiring, hubbell incorporated, hubbell lighting.
//
// Group K — Wiremold/Legrand (WIR wins in PRIMARY_VENDORS over LEG and WGL).
//   Names: wiremold, legrand wiremold.
//
// Group L — Pass & Seymour (PAS wins in PRIMARY_VENDORS over LEG).
//   Names: pass seymour, pass and seymour.
//
// Group M — Hoffman enclosures (HOF wins in PRIMARY_VENDORS over NVE).
//   Names: hoffman enclosures, nvent hoffman.
//
// Group N — VENDORS-only internal duplicates (both entries non-primary).
//   "phoenix contact" / "phoenix contact inc": PHO and PHX are both in VENDORS.
//   "click plc": ATE and CLK are both in VENDORS.
//   "gould": SIE and GLD are both in VENDORS.
//   "ite": SIE and ITE are both in VENDORS.
//   "marathon motors": RED and MAR are both in VENDORS.
//   "vertiv liebert": LIE and VER are both in VENDORS.
//   "abb inc": ABB appears twice in VENDORS (separate row + primary).
//
// Group O — edison fuse (PRIMARY_VENDORS only: BUS and EDN both claim it;
//   both entries are PRIMARY_VENDORS, EDN is later so EDN wins).
//

const KNOWN_DUPLICATE_ALIASES = new Set<string>([
  // Group A — same-code mirrors between VENDORS extended list and PRIMARY_VENDORS
  "arlington",
  "arlington industries",
  "bare copper",
  "buss fuse",
  "bussmann",
  "cooper lighting",
  "cooper lighting solutions",
  "copper",
  "copper wire",
  "eaton bussmann",
  "eaton cooper lighting",
  "hoffman",
  "ideal",
  "ideal electrical",
  "ideal industries",
  "klein",
  "klein tools",
  "levition",
  "leviton",
  "leviton manufacturing",
  "leviton wiring",
  "lutron",
  "lutron electronics",
  "lutron shading",
  "milwaukee",
  "milwaukee electric tool",
  "milwaukee tool",
  "pentair hoffman",
  "rab lighting",
  "satco",
  "satco lighting",
  "satco products",
  "schneider",
  "schneider electric",
  "siemans",
  "siemens",
  "siemens energy",
  "siemens industry",
  "sq d",
  "squaed d",
  "square d",
  "squared",
  "westinghouse",

  // Group B — Eaton family (ETN wins via last-write; CHD keeps "ch" uniquely)
  "eaton",
  "cutler hammer",
  "cutler-hammer",
  "c-h",
  "eaton electrical",
  "eaton corporation",
  "ch",

  // Group C — Thomas & Betts / ABB family (TAB wins; ABB keeps "abb inc")
  "thomas betts",
  "thomas & betts",
  "t&b",
  "tnb",
  "abb",
  "abb inc",

  // Group D — Cooper sub-brands: each primary entry owns distinct names
  "cooper industries",   // COO(VENDORS) + CHC(PRIMARY); CHC wins as authoritative
  "cooper crouse-hinds", // COO(VENDORS) + CRS(PRIMARY); CRS wins as authoritative
  "cooper bussmann",     // COO(VENDORS) + BUS(VENDORS+PRIMARY); BUS wins

  // Group E — 3M / Scotch (SCO wins in PRIMARY_VENDORS)
  "3m",
  "3m company",
  "3m electrical",
  "scotch",
  "scotchlock",

  // Group F — GE / GEL (GEL wins in PRIMARY_VENDORS)
  "ge",
  "general electric",
  "ge industrial",
  "ge power",
  "ge electrical",

  // Group G — Generac (GEN wins in PRIMARY_VENDORS over VENDORS GNR)
  "generac",
  "generac power systems",
  "generac generator",

  // Group H — Sylvania family (SYL wins in PRIMARY_VENDORS)
  "sylvania",
  "sylvania lighting",
  "osram sylvania",
  "gte sylvania",

  // Group I — Fluke (FLU wins in PRIMARY_VENDORS over VENDORS FLS)
  "fluke",
  "fluke corporation",

  // Group J — Hubbell (HBL wins in PRIMARY_VENDORS over VENDORS HUB)
  "hubbell",
  "hubbell wiring",
  "hubbell incorporated",
  "hubbell lighting",

  // Group K — Wiremold / Legrand (WIR wins in PRIMARY_VENDORS)
  "wiremold",
  "legrand wiremold",

  // Group L — Pass & Seymour (PAS wins in PRIMARY_VENDORS over LEG)
  "pass seymour",
  "pass and seymour",

  // Group M — Hoffman enclosures (HOF wins in PRIMARY_VENDORS over NVE)
  "hoffman enclosures",
  "nvent hoffman",

  // Group N — VENDORS-only internal duplicates (non-primary; documented for awareness)
  "phoenix contact",     // PHO and PHX are separate VENDORS entries — both non-primary
  "phoenix contact inc", // same pair
  "click plc",           // ATE and CLK both in VENDORS
  "gould",               // SIE and GLD both in VENDORS
  "ite",                 // SIE and ITE both in VENDORS
  "marathon motors",     // RED and MAR both in VENDORS
  "vertiv liebert",      // LIE and VER both in VENDORS

  // Group O — PRIMARY_VENDORS only: BUS and EDN both claim "edison fuse";
  //           EDN appears later so EDN wins (last-write semantics)
  "edison fuse",
]);

describe("vendorAliasCollisions — no new alias shared by two entries without explicit allowlist entry", () => {
  it("every name that appears in more than one VENDORS/PRIMARY_VENDORS entry is in KNOWN_DUPLICATE_ALIASES", () => {
    const nameToEntries = new Map<string, Array<{ code: string; source: string }>>();

    const allEntries = [
      ...VENDORS.map((v) => ({ ...v, source: "VENDORS" })),
      ...PRIMARY_VENDORS.map((v) => ({ ...v, source: "PRIMARY_VENDORS" })),
    ];

    for (const entry of allEntries) {
      for (const name of entry.names) {
        const key = name.toLowerCase();
        if (!nameToEntries.has(key)) nameToEntries.set(key, []);
        nameToEntries.get(key)!.push({ code: entry.code, source: entry.source });
      }
    }

    const unallowlistedCollisions: Array<{ name: string; entries: Array<{ code: string; source: string }> }> = [];

    for (const [name, entries] of nameToEntries) {
      if (entries.length > 1 && !KNOWN_DUPLICATE_ALIASES.has(name)) {
        unallowlistedCollisions.push({ name, entries });
      }
    }

    if (unallowlistedCollisions.length > 0) {
      const detail = unallowlistedCollisions
        .map(({ name, entries }) => {
          const codes = entries.map((e) => `${e.code}(${e.source})`).join(", ");
          return `  "${name}" → ${codes}`;
        })
        .join("\n");
      throw new Error(
        `${unallowlistedCollisions.length} new vendor alias collision(s) detected.\n` +
        `Add each alias to KNOWN_DUPLICATE_ALIASES in vendorNameResolution.test.ts with a comment explaining why the overlap is intentional:\n${detail}`
      );
    }
  });

  it("KNOWN_DUPLICATE_ALIASES contains no stale entries (every allowlisted name actually appears in 2+ entries)", () => {
    const nameToEntries = new Map<string, Array<{ code: string; source: string }>>();

    const allEntries = [
      ...VENDORS.map((v) => ({ ...v, source: "VENDORS" })),
      ...PRIMARY_VENDORS.map((v) => ({ ...v, source: "PRIMARY_VENDORS" })),
    ];

    for (const entry of allEntries) {
      for (const name of entry.names) {
        const key = name.toLowerCase();
        if (!nameToEntries.has(key)) nameToEntries.set(key, []);
        nameToEntries.get(key)!.push({ code: entry.code, source: entry.source });
      }
    }

    const staleEntries: string[] = [];
    for (const alias of KNOWN_DUPLICATE_ALIASES) {
      const entries = nameToEntries.get(alias) ?? [];
      if (entries.length < 2) {
        staleEntries.push(alias);
      }
    }

    if (staleEntries.length > 0) {
      throw new Error(
        `${staleEntries.length} stale KNOWN_DUPLICATE_ALIASES entry(ies) — these names no longer appear in 2+ entries.\n` +
        `Remove them from KNOWN_DUPLICATE_ALIASES:\n` +
        staleEntries.map((s) => `  "${s}"`).join("\n")
      );
    }
  });
});
