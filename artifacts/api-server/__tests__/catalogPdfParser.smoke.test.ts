/**
 * Smoke tests for vendor catalog PDF profiles.
 *
 * These run `parseCatalogPdf` directly (no DB, no Express) against real
 * catalog PDF fixtures in `attached_assets/`:
 *
 *   - Bridgeport Fittings 2026 → BRIDGEPORT (strategy: index)
 *   - Elliott Electric Supply 06.2025 → ARLINGTON / CROUSE-HINDS / CANTEX
 *     (strategy: vendor-section)
 *
 * Each smoke test asserts a sane minimum entry count and that a known
 * sample catalog number from that vendor was parsed with the expected
 * dimension chips. The thresholds are intentionally loose so that minor
 * future tweaks to the vendor-section parser do not break CI.
 */

import path from "node:path";
import fs from "node:fs";
import {
  parseCatalogPdf,
  BRIDGEPORT_PROFILE,
  ARLINGTON_PROFILE,
  CROUSE_HINDS_PROFILE,
  CANTEX_PROFILE,
  listVendorProfiles,
  getVendorProfile,
} from "../src/utils/catalogPdfParser";

const BRIDGEPORT_PDF = path.resolve(
  __dirname,
  "../../../attached_assets/Bridgeport_Fittings_2026_Catalog_Part1_1777767002957.pdf",
);
const EES_PDF = path.resolve(
  __dirname,
  "../../../attached_assets/EES_Product_Catalog_(06.2025)_1777753661302.pdf",
);

const haveBridgeport = fs.existsSync(BRIDGEPORT_PDF);
const haveEes = fs.existsSync(EES_PDF);

let bridgeportBuf: Buffer | null = null;
let eesBuf: Buffer | null = null;

beforeAll(() => {
  if (haveBridgeport) bridgeportBuf = fs.readFileSync(BRIDGEPORT_PDF);
  if (haveEes) eesBuf = fs.readFileSync(EES_PDF);
});

describe("listVendorProfiles / getVendorProfile", () => {
  it("returns at least Bridgeport plus two more vendor-section profiles", () => {
    const list = listVendorProfiles();
    const codes = list.map(v => v.vendor);
    expect(codes).toEqual(expect.arrayContaining(["BRIDGEPORT", "ARLINGTON", "CROUSE-HINDS", "CANTEX"]));
    expect(list.length).toBeGreaterThanOrEqual(3);
  });

  it("resolves common aliases (case + punctuation insensitive)", () => {
    expect(getVendorProfile("Bridgeport")?.vendor).toBe("BRIDGEPORT");
    expect(getVendorProfile("bridgeport fittings")?.vendor).toBe("BRIDGEPORT");
    expect(getVendorProfile("crouse hinds")?.vendor).toBe("CROUSE-HINDS");
    expect(getVendorProfile("Eaton Crouse-Hinds")?.vendor).toBe("CROUSE-HINDS");
    expect(getVendorProfile("Arlington Industries")?.vendor).toBe("ARLINGTON");
    expect(getVendorProfile("Cantex, Inc.")?.vendor).toBe("CANTEX");
    expect(getVendorProfile("not-a-vendor")).toBeNull();
  });
});

const describeIfBridgeport = haveBridgeport ? describe : describe.skip;
const describeIfEes = haveEes ? describe : describe.skip;

describeIfBridgeport("Bridgeport profile (strategy: index)", () => {
  it("parses thousands of catalog entries with sample dimension chips", async () => {
    const entries = await parseCatalogPdf(bridgeportBuf!, BRIDGEPORT_PROFILE, { extractBodySnippets: false });
    expect(entries.length).toBeGreaterThan(3000);

    const byCatalog = new Map(entries.map(e => [e.catalogNumber, e]));

    // 239-DC2's primary page falls in the RMC/IMC Fitting range (64-105)
    // and the -DC2 suffix injects "die cast".
    const dc2 = byCatalog.get("239-DC2");
    expect(dc2).toBeDefined();
    expect(dc2!.dimensions.category).toBe("Fitting");
    expect(dc2!.dimensions.conduitType).toBe("RMC");
    expect(dc2!.keywords.map(k => k.toLowerCase())).toEqual(
      expect.arrayContaining(["bridgeport fittings", "die cast"]),
    );

    // 231-SBLK is a color-coded EMT fitting → colorChip=Black, "black" kw.
    const sblk = byCatalog.get("231-SBLK");
    expect(sblk).toBeDefined();
    expect(sblk!.dimensions.colorChip).toBe("Black");
    expect(sblk!.keywords.map(k => k.toLowerCase())).toContain("black");
  }, 60_000);
});

describeIfEes("Arlington profile (strategy: vendor-section, EES)", () => {
  it("parses Arlington catalog numbers from the EES distributor catalog", async () => {
    const entries = await parseCatalogPdf(eesBuf!, ARLINGTON_PROFILE, { extractBodySnippets: false });
    // EES carries a small Arlington selection (~20-50 entries depending on
    // the year). Threshold is conservative.
    expect(entries.length).toBeGreaterThanOrEqual(10);

    const byCatalog = new Map(entries.map(e => [e.catalogNumber, e]));

    // NM94 / NM95 are Arlington NM cable connectors on EES page D6.
    expect(byCatalog.has("NM94")).toBe(true);
    const nm94 = byCatalog.get("NM94")!;
    expect(nm94.dimensions.category).toBe("Connector");
    expect(nm94.keywords.map(k => k.toLowerCase())).toEqual(
      expect.arrayContaining(["arlington industries"]),
    );
  }, 60_000);
});

describeIfEes("Crouse-Hinds profile (strategy: vendor-section, EES)", () => {
  it("parses Crouse-Hinds catalog numbers from the EES distributor catalog", async () => {
    const entries = await parseCatalogPdf(eesBuf!, CROUSE_HINDS_PROFILE, { extractBodySnippets: false });
    // Crouse-Hinds is the largest vendor in the EES Conduit/Fittings and
    // Harsh Locations sections — hundreds of catalog numbers.
    expect(entries.length).toBeGreaterThan(200);

    // CG cord-grip series catalog numbers (e.g. CG50250) appear in EES
    // page 107 (Wire & Cable section in this profile's mapping) and inherit
    // the Connector category chip + the vendor display-name keyword.
    const cg = entries.find(e => e.catalogNumber === "CG50250");
    expect(cg).toBeDefined();
    expect(cg!.dimensions.category).toBeDefined();
    expect(["Fitting", "Connector"]).toContain(cg!.dimensions.category);
    expect(cg!.keywords.map(k => k.toLowerCase())).toEqual(
      expect.arrayContaining(["eaton crouse-hinds series"]),
    );
  }, 60_000);
});

describeIfEes("Cantex profile (strategy: vendor-section, EES)", () => {
  it("parses Cantex PVC catalog numbers from the EES distributor catalog", async () => {
    const entries = await parseCatalogPdf(eesBuf!, CANTEX_PROFILE, { extractBodySnippets: false });
    expect(entries.length).toBeGreaterThanOrEqual(20);

    // ELL90 / ELL45 elbow series should land in the PVC Fitting page range
    // and pick up the elbow keyword from the suffix rule.
    const elbow = entries.find(e => e.catalogNumber.endsWith("ELL90"));
    expect(elbow).toBeDefined();
    expect(elbow!.dimensions.conduitType).toBe("PVC");
    expect(elbow!.keywords.map(k => k.toLowerCase())).toEqual(
      expect.arrayContaining(["elbow", "pvc"]),
    );
  }, 60_000);
});
