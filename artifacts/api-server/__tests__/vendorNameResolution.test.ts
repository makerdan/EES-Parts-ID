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

import { PRIMARY_VENDORS } from "../src/seed/dictionaries";

// ── Resolution algorithm (mirrors inventory.ts) ───────────────────────────────

/** Codes that must win over any conflicting primary entry (mirrors inventory.ts). */
const PRIORITY_CODES = ["CRS"];

function buildSyntheticReverseVendorMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of PRIMARY_VENDORS) {
    for (const name of v.names) map.set(name.toLowerCase(), v.code);
  }
  for (const code of PRIORITY_CODES) {
    const entry = PRIMARY_VENDORS.find((v) => v.code === code);
    if (entry) {
      for (const name of entry.names) map.set(name.toLowerCase(), code);
    }
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
// If someone re-orders PRIMARY_VENDORS or changes PRIORITY_CODES, these
// declarations catch the regression.

/**
 * Names that appear in more than one PRIMARY_VENDORS entry.
 * Value = the code that WINS in the synthetic map (based on array order + PRIORITY_CODES).
 *
 * Derivation:
 *   - "crouse-hinds" / "crouse hinds" / "cooper crouse-hinds" / "eaton crouse-hinds":
 *       CHC (early) and CRS (next) share all four; CRS is in PRIORITY_CODES → CRS wins.
 *   - "eaton" / "cutler hammer" / "cutler-hammer" / "c-h" / "eaton electrical":
 *       CHD (earlier in array) and ETN (later) share these → ETN wins (last-write).
 *   - "eaton electrical" is also in EAT (between CHD and ETN) — ETN still wins (latest).
 *   - "eaton corporation": EAT (earlier) and ETN (later) → ETN wins.
 *   - "thomas betts" / "thomas & betts" / "t&b": ABB (early) and TAB (latest) → TAB wins.
 *   - "edison fuse": BUS (earlier) and EDN (later) → EDN wins.
 */
const CONFLICT_WINNERS = new Map<string, string>([
  // CRS wins via PRIORITY_CODES (beats CHC for all shared crouse-hinds variants)
  ["crouse-hinds",        "CRS"],
  ["crouse hinds",        "CRS"],
  ["cooper crouse-hinds", "CRS"],
  ["eaton crouse-hinds",  "CRS"],

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

// ── Tests: PRIORITY_CODES override (CRS beats CHC) ───────────────────────────

describe("vendorNameResolution — PRIORITY_CODES: CRS wins over CHC for all shared names", () => {
  const map = buildSyntheticReverseVendorMap();

  it("'crouse-hinds' → CRS (not CHC)", () => {
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

  it("CHC owns no names in the map (all overridden by CRS)", () => {
    for (const name of PRIMARY_VENDORS.find((v) => v.code === "CHC")!.names) {
      expect(map.get(name.toLowerCase())).toBe("CRS");
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
