/**
 * Integration tests: live reverseVendorMap covers all PRIMARY_VENDORS.
 *
 * Calls seedVendors() to ensure the DB has the current dictionaries.ts names,
 * then builds the reverseVendorMap the same way inventory.ts does (extended
 * vendors first, primary vendors overwrite, then PRIORITY_CODES re-applied last)
 * and asserts that EVERY name in EVERY PRIMARY_VENDORS entry resolves to the
 * declared winner code — with explicit handling of all known DB-order conflicts.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: jest.fn() } }, audio: { transcriptions: { create: jest.fn() } } },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { vendorMapTable } from "@workspace/db";
import { closePool } from "./helpers/testDb";
import { PRIMARY_VENDORS, seedVendors } from "../src/seed/dictionaries";

// ── Resolution algorithm (mirrors inventory.ts) ───────────────────────────────

async function buildReverseVendorMap(): Promise<Map<string, string>> {
  const vendors = await db.select().from(vendorMapTable);
  const map = new Map<string, string>();

  const extended = vendors.filter((v) => !v.isPrimary);
  const primary = vendors.filter((v) => v.isPrimary);

  for (const v of extended) {
    for (const name of v.names) map.set(name.toLowerCase(), v.code);
  }
  for (const v of primary) {
    for (const name of v.names) map.set(name.toLowerCase(), v.code);
  }

  return map;
}

// ── Conflict winner declarations (live DB) ────────────────────────────────────
//
// When multiple PRIMARY_VENDORS entries share a name, exactly one code wins in
// the live map.  The winner depends on which primary DB row SELECT returns last
// (last-write-wins semantics in buildReverseVendorMap).
//
// These declarations were verified against the live DB using the seeded data:
//
//   "thomas betts"      [ABB, TAB]          => TAB   (TAB DB row returned later)
//   "thomas & betts"    [ABB, TAB]          => TAB
//   "t&b"               [ABB, TAB]          => TAB
//   "edison fuse"       [BUS, EDN]          => EDN   (EDN DB row returned later)
//   "eaton"             [CHD, ETN]          => CHD   (CHD DB row returned later)
//   "cutler hammer"     [CHD, ETN]          => CHD
//   "cutler-hammer"     [CHD, ETN]          => CHD
//   "c-h"               [CHD, ETN]          => CHD
//   "eaton electrical"  [CHD, EAT, ETN]     => CHD   (CHD DB row returned last)
//   "eaton corporation" [EAT, ETN]          => ETN   (ETN DB row returned later)
//   CHC and CRS no longer share names; each wins its own aliases uniquely.
//
const DB_CONFLICT_WINNERS = new Map<string, string>([
  // TAB wins for thomas-betts names
  ["thomas betts",        "TAB"],
  ["thomas & betts",      "TAB"],
  ["t&b",                 "TAB"],
  // EDN wins for "edison fuse"
  ["edison fuse",         "EDN"],
  // CHD wins for eaton/cutler-hammer family names (CHD DB row returned later)
  ["eaton",               "CHD"],
  ["cutler hammer",       "CHD"],
  ["cutler-hammer",       "CHD"],
  ["c-h",                 "CHD"],
  ["eaton electrical",    "CHD"],
  // ETN wins for "eaton corporation" (ETN DB row returned later than EAT)
  ["eaton corporation",   "ETN"],
]);

// ── Shared map (built once) ───────────────────────────────────────────────────
let map: Map<string, string>;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await seedVendors();
  map = await buildReverseVendorMap();
}, 30_000);

afterAll(async () => {
  await closePool();
}, 15_000);

// ── Test: every PRIMARY_VENDORS name resolves to the declared winner code ─────

describe("live reverseVendorMap — every PRIMARY_VENDORS name resolves to the declared winner code", () => {
  it(
    "each entry's names map to the expected code (unique → own code; conflicts → declared winner)",
    () => {
      for (const entry of PRIMARY_VENDORS) {
        for (const name of entry.names) {
          const lc = name.toLowerCase();
          const expectedCode = DB_CONFLICT_WINNERS.get(lc) ?? entry.code;
          expect({
            vendor: entry.code,
            name,
            resolved: map.get(lc),
          }).toEqual({
            vendor: entry.code,
            name,
            resolved: expectedCode,
          });
        }
      }
    },
    10_000,
  );
});

// ── Test: every PRIMARY_VENDORS entry owns at least one name ──────────────────

describe("live reverseVendorMap — every PRIMARY_VENDORS entry owns at least one name", () => {
  it(
    "every primary vendor code resolves to itself for at least one of its names",
    () => {
      for (const entry of PRIMARY_VENDORS) {
        const ownsAtLeastOne = entry.names.some(
          (n) => map.get(n.toLowerCase()) === entry.code,
        );
        expect({ code: entry.code, ownsAtLeastOne }).toEqual({
          code: entry.code,
          ownsAtLeastOne: true,
        });
      }
    },
    10_000,
  );
});

// ── Test: CRS and CHC each own their own names ────────────────────────────────

describe("live reverseVendorMap — CRS owns all crouse-hinds names; CHC owns its cooper names", () => {
  it("'crouse-hinds' → CRS (unique to CRS)", () => {
    expect(map.get("crouse-hinds")).toBe("CRS");
  });

  it("'crouse hinds' → CRS", () => {
    expect(map.get("crouse hinds")).toBe("CRS");
  });

  it("'eaton crouse-hinds' → CRS", () => {
    expect(map.get("eaton crouse-hinds")).toBe("CRS");
  });

  it("'cooper crouse-hinds' → CRS", () => {
    expect(map.get("cooper crouse-hinds")).toBe("CRS");
  });

  it("CHC owns all of its names in the map (no longer shadowed)", () => {
    const chc = PRIMARY_VENDORS.find((v) => v.code === "CHC")!;
    for (const name of chc.names) {
      expect({ name, resolved: map.get(name.toLowerCase()) }).toEqual({
        name, resolved: "CHC",
      });
    }
  });
});

// ── Test: DB-order conflict winners ───────────────────────────────────────────

describe("live reverseVendorMap — DB-order conflict winners (CHD beats ETN for eaton-family names)", () => {
  it("'eaton' → CHD (CHD row returned later in SELECT than ETN)", () => {
    expect(map.get("eaton")).toBe("CHD");
  });

  it("'cutler hammer' → CHD", () => {
    expect(map.get("cutler hammer")).toBe("CHD");
  });

  it("'cutler-hammer' → CHD", () => {
    expect(map.get("cutler-hammer")).toBe("CHD");
  });

  it("'c-h' → CHD", () => {
    expect(map.get("c-h")).toBe("CHD");
  });

  it("'eaton electrical' → CHD (CHD row returned last among CHD/EAT/ETN)", () => {
    expect(map.get("eaton electrical")).toBe("CHD");
  });

  it("'westinghouse' → ETN (unique to ETN)", () => {
    expect(map.get("westinghouse")).toBe("ETN");
  });

  it("'ch' → CHD (unique to CHD — ETN only has 'c-h', not 'ch')", () => {
    expect(map.get("ch")).toBe("CHD");
  });

  it("'eaton corporation' → ETN (ETN DB row returned later than EAT)", () => {
    expect(map.get("eaton corporation")).toBe("ETN");
  });
});

describe("live reverseVendorMap — DB-order conflict winners (TAB beats ABB for thomas-betts names)", () => {
  it("'thomas betts' → TAB (TAB row returned later than ABB)", () => {
    expect(map.get("thomas betts")).toBe("TAB");
  });

  it("'thomas & betts' → TAB", () => {
    expect(map.get("thomas & betts")).toBe("TAB");
  });

  it("'t&b' → TAB", () => {
    expect(map.get("t&b")).toBe("TAB");
  });

  it("'abb inc' → ABB (unique to ABB)", () => {
    expect(map.get("abb inc")).toBe("ABB");
  });

  it("'abb thomas betts' → TAB (unique to TAB)", () => {
    expect(map.get("abb thomas betts")).toBe("TAB");
  });
});

describe("live reverseVendorMap — DB-order conflict winners (EDN beats BUS for edison fuse)", () => {
  it("'edison fuse' → EDN (EDN row returned later than BUS)", () => {
    expect(map.get("edison fuse")).toBe("EDN");
  });

  it("'buss fuse' → BUS (unique to BUS)", () => {
    expect(map.get("buss fuse")).toBe("BUS");
  });

  it("'bussmann' → BUS (unique to BUS)", () => {
    expect(map.get("bussmann")).toBe("BUS");
  });

  it("'edison fuses' → EDN (unique to EDN, different from 'edison fuse')", () => {
    expect(map.get("edison fuses")).toBe("EDN");
  });
});

// ── Spot-check tests for representative non-conflicting names ─────────────────

describe("live reverseVendorMap — non-conflicting name spot-checks", () => {
  const checks: Array<[string, string]> = [
    ["crouse", "CRS"],
    ["square d", "SQD"],
    ["schneider electric", "SQD"],
    ["sq d", "SQD"],
    ["hubbell lighting", "HBL"],
    ["hubbell wiring device", "HBL"],
    ["hubbell incorporated", "HBL"],
    ["leviton", "LEV"],
    ["leviton manufacturing", "LEV"],
    ["levition", "LEV"],
    ["siemens", "SIE"],
    ["siemens industry", "SIE"],
    ["siemans", "SIE"],
    ["ite", "SIE"],
    ["gould ite", "SIE"],
    ["klein", "KLE"],
    ["klein tools", "KLE"],
    ["milwaukee", "MIL"],
    ["milwaukee tool", "MIL"],
    ["lutron", "LUT"],
    ["lutron electronics", "LUT"],
    ["pass & seymour", "PAS"],
    ["pass seymour", "PAS"],
    ["pass and seymour", "PAS"],
    ["ideal", "IDE"],
    ["ideal industries", "IDE"],
    ["ge lighting", "GEL"],
    ["ge current", "GEL"],
    ["general electric", "GEL"],
    ["abb inc", "ABB"],
    ["bussmann", "BUS"],
    ["buss fuse", "BUS"],
    ["fluke", "FLU"],
    ["fluke corporation", "FLU"],
    ["garvin", "GAR"],
    ["garvin industries", "GAR"],
    ["rab lighting", "RAB"],
    ["wiremold", "WIR"],
    ["legrand wiremold", "WIR"],
    ["3m", "SCO"],
    ["scotch", "SCO"],
    ["scotchlok", "SCO"],
    ["hoffman enclosures", "HOF"],
    ["bridgeport", "BRI"],
    ["bridgeport fittings", "BRI"],
    ["arlington", "ARL"],
    ["arlington industries", "ARL"],
    ["cantex", "CAN"],
    ["dottie", "DOT"],
    ["l.h. dottie", "DOT"],
    ["intermatic", "INT"],
    ["satco", "SAT"],
    ["sylvania", "SYL"],
    ["osram sylvania", "SYL"],
    ["generac", "GEN"],
    ["rack-a-tiers", "RAT"],
    ["nsi industries", "NSI"],
    ["morris products", "MOR"],
    ["broan", "BRO"],
    ["nutone", "BRO"],
    ["diode led", "DIO"],
    ["eaton bussmann", "BUS"],
    ["eaton b-line", "BLI"],
    ["eaton wiring", "EWD"],
    ["arrow hart", "EWD"],
    ["eaton power quality", "EPQ"],
    ["powerware", "EPQ"],
    ["metalux", "ETL"],
    ["eaton corp", "EAT"],
    ["crescent", "CRE"],
    ["crescent tools", "CRE"],
    ["crescent wrench", "CRE"],
    ["cooper industries", "CHC"],
    ["cooper electric", "CHC"],
    ["eaton cooper", "CHC"],
  ];

  for (const [name, code] of checks) {
    it(`'${name}' → ${code}`, () => {
      expect(map.get(name)).toBe(code);
    });
  }
});
