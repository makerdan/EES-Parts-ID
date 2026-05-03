/**
 * Vendor catalog PDF parser.
 *
 * Given a PDF buffer + a vendor profile, returns a list of
 * `{ catalogNumber, pageNumbers, description, dimensions, keywords }`
 * entries by:
 *
 *   1. Running `pdftotext -layout` on the buffer (via a tempfile, since
 *      poppler reads from disk) and splitting output on form-feed `\f`
 *      to get per-page text.
 *   2. Locating the vendor's "INDEX BY CATALOG NUMBER" pages, splitting
 *      each line on multi-space gaps to recover the original column
 *      cells, then parsing each cell as
 *      `<catalog-token> <page1>, <page2>, …`.
 *   3. For each entry, mapping the primary referenced page through the
 *      vendor's page-range → dimension table to seed the chip dimensions
 *      we actually know how to derive (category, conduitType, colorChip).
 *      Keywords are seeded from the vendor name + dimension labels +
 *      catalog-suffix hints (e.g. `-DC2`).
 *   4. Optionally pulling a short description snippet from the body
 *      page if the catalog number appears verbatim in the page text.
 *
 * Currently only the Bridgeport profile ships; the shape is
 * intentionally generic so adding a second vendor is just another
 * profile + page-range table.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

export interface CatalogEntry {
  catalogNumber: string;
  pageNumbers: number[];
  description: string;
  dimensions: Record<string, string>;
  keywords: string[];
}

export interface PageRangeRule {
  startPage: number;
  endPage: number;
  /** Chip dimensions to apply to every catalog whose primary page falls in this range. */
  dimensions: Record<string, string>;
  /** Description / keyword hints for entries in this range. */
  keywords: string[];
  /** Display label injected into the description if no body-text snippet is found. */
  label: string;
}

export interface SuffixRule {
  /** Suffix substring (case-insensitive) to look for at end of catalog number. */
  suffix: string;
  dimensions: Record<string, string>;
  keywords: string[];
}

export interface VendorProfile {
  /** Canonical vendor code stored in the inventory.vendor column (uppercased). */
  vendor: string;
  /** Human-readable display name (e.g. "Bridgeport Fittings"). */
  displayName: string;
  /** Pages (1-indexed) that contain the "INDEX BY CATALOG NUMBER" listing. */
  indexPages: { firstPage: number; lastPage: number };
  /** Page-range → dimension mapping derived from the catalog table of contents. */
  pageRanges: PageRangeRule[];
  /** Catalog-suffix → dimension mapping (color codes etc.). */
  suffixRules: SuffixRule[];
}

// ── Bridgeport 2026 profile ──────────────────────────────────────────────────
//
// Page ranges below come from the table of contents on pages 6-7 of
// `attached_assets/Bridgeport_Fittings_2026_Catalog_Part1_*.pdf`.
// Add a new vendor by exporting a sibling profile constant; the matcher and
// route are vendor-agnostic.
export const BRIDGEPORT_PROFILE: VendorProfile = {
  vendor: "BRIDGEPORT",
  displayName: "Bridgeport Fittings",
  indexPages: { firstPage: 8, lastPage: 19 },
  pageRanges: [
    {
      startPage: 30, endPage: 41,
      dimensions: { category: "Fitting" },
      keywords: ["solar", "fitting"],
      label: "Solar Fitting",
    },
    {
      startPage: 40, endPage: 55,
      dimensions: { category: "Fitting", conduitType: "RMC" },
      keywords: ["rigid", "imc", "conduit body"],
      label: "RMC/IMC Conduit Body",
    },
    {
      startPage: 56, endPage: 63,
      dimensions: { category: "Fitting", conduitType: "EMT" },
      keywords: ["emt", "conduit body"],
      label: "EMT Conduit Body",
    },
    {
      startPage: 64, endPage: 105,
      dimensions: { category: "Fitting", conduitType: "RMC" },
      keywords: ["rigid", "imc", "fitting"],
      label: "RMC/IMC Fitting",
    },
    {
      startPage: 106, endPage: 137,
      dimensions: { category: "Fitting", conduitType: "EMT" },
      keywords: ["emt", "fitting"],
      label: "EMT Fitting",
    },
    {
      startPage: 138, endPage: 143,
      dimensions: { category: "Fitting", conduitType: "EMT" },
      keywords: ["emt", "fitting", "color coded"],
      label: "Color Coded EMT Fitting",
    },
    {
      startPage: 144, endPage: 155,
      dimensions: { category: "Fitting", conduitType: "LFMC" },
      keywords: ["liquid tight", "fitting"],
      label: "Liquid Tight Fitting",
    },
    {
      startPage: 156, endPage: 171,
      dimensions: { category: "Fitting", environment: "Wet" },
      keywords: ["raintight", "fitting"],
      label: "Raintight Fitting",
    },
    {
      startPage: 172, endPage: 183,
      dimensions: { category: "Fitting" },
      keywords: ["bushing"],
      label: "Bushing",
    },
    {
      startPage: 184, endPage: 199,
      dimensions: { category: "Fitting" },
      keywords: ["snap-in", "fitting"],
      label: "Snap-In Fitting",
    },
    {
      startPage: 200, endPage: 225,
      dimensions: { category: "Fitting", conduitType: "FMC" },
      keywords: ["fmc", "flexible metal", "fitting"],
      label: "FMC Fitting",
    },
    {
      startPage: 226, endPage: 259,
      dimensions: { category: "Connector", wireType: "MC" },
      keywords: ["armored", "metal clad", "ac", "mc", "fitting"],
      label: "Armored / MC Cable Fitting",
    },
    {
      startPage: 260, endPage: 269,
      dimensions: { category: "Fitting" },
      keywords: ["transition", "fitting"],
      label: "Transition Fitting",
    },
    {
      startPage: 270, endPage: 281,
      dimensions: { category: "Connector" },
      keywords: ["nm", "nonmetallic", "portable cord", "fitting"],
      label: "Nonmetallic Cable / Cord Fitting",
    },
    {
      startPage: 282, endPage: 319,
      dimensions: { category: "Connector" },
      keywords: ["cord grip", "cable gland"],
      label: "Cord Grip / Cable Gland",
    },
    {
      startPage: 320, endPage: 323,
      dimensions: { category: "Fitting" },
      keywords: ["drain", "vent"],
      label: "Drain Fitting / Vent",
    },
    {
      startPage: 324, endPage: 337,
      dimensions: { category: "Connector" },
      keywords: ["grounding", "ground"],
      label: "Grounding Product",
    },
    {
      startPage: 338, endPage: 353,
      dimensions: { category: "Fitting", mountingType: "Surface" },
      keywords: ["strap", "clamp", "hanger"],
      label: "Strap / Clamp / Hanger",
    },
    {
      startPage: 354, endPage: 367,
      dimensions: { category: "Fitting" },
      keywords: ["service entrance"],
      label: "Service Entrance Fitting",
    },
    {
      startPage: 368, endPage: 386,
      dimensions: {},
      keywords: ["voice", "data", "fire alarm", "specialty"],
      label: "Voice / Data / Fire Alarm Fitting",
    },
  ],
  // Color codes from the Color Coded EMT Fittings section (pages 138-143).
  // Bridgeport uses single-letter color codes after `-S`, e.g. `231-SR`.
  suffixRules: [
    { suffix: "-SBLK", dimensions: { colorChip: "Black" }, keywords: ["black"] },
    { suffix: "-SBLU", dimensions: { colorChip: "Blue" }, keywords: ["blue"] },
    { suffix: "-SG",   dimensions: { colorChip: "Gray" }, keywords: ["gray"] },
    { suffix: "-SR",   dimensions: { colorChip: "Red" }, keywords: ["red"] },
    { suffix: "-SW",   dimensions: { colorChip: "White" }, keywords: ["white"] },
    { suffix: "-SY",   dimensions: { colorChip: "Yellow" }, keywords: ["yellow"] },
    { suffix: "-SO",   dimensions: { colorChip: "Orange" }, keywords: ["orange"] },
    { suffix: "-I",    dimensions: {}, keywords: ["insulated"] },
    { suffix: "-DCI2", dimensions: {}, keywords: ["die cast", "insulated"] },
    { suffix: "-DC2",  dimensions: {}, keywords: ["die cast"] },
    { suffix: "-DC",   dimensions: {}, keywords: ["die cast"] },
    { suffix: "-MB",   dimensions: {}, keywords: ["malleable"] },
    { suffix: "-RT",   dimensions: { environment: "Wet" }, keywords: ["raintight"] },
    { suffix: "-LT",   dimensions: { conduitType: "LFMC" }, keywords: ["liquid tight"] },
  ],
};

const VENDOR_PROFILES: Record<string, VendorProfile> = {
  BRIDGEPORT: BRIDGEPORT_PROFILE,
};

export function getVendorProfile(vendor: string): VendorProfile | null {
  return VENDOR_PROFILES[vendor.trim().toUpperCase()] ?? null;
}

// ── pdftotext driver ────────────────────────────────────────────────────────
//
// poppler reads from disk (or stdin via "-"). We write the buffer to a
// tempfile so we can also page-slice with -f / -l on a second invocation if
// needed without re-passing 30+ MB through stdin.
function writeTempPdf(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-pdf-"));
  const file = path.join(dir, `${crypto.randomBytes(4).toString("hex")}.pdf`);
  fs.writeFileSync(file, buf);
  return file;
}

function pdftotextLayout(pdfPath: string, firstPage?: number, lastPage?: number): string {
  const args = ["-layout"];
  if (firstPage) args.push("-f", String(firstPage));
  if (lastPage) args.push("-l", String(lastPage));
  args.push(pdfPath, "-");
  return execFileSync("pdftotext", args, {
    encoding: "utf-8",
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ── Index page parser ───────────────────────────────────────────────────────
//
// Each line in the layout-preserved index looks like
//
//   239-DC2 64, 107         239-SBLK 139            239-SR 143, 364, 365
//
// Splitting on runs of 2+ spaces recovers the column cells. Within a cell we
// split off the first whitespace-separated token as the catalog number and
// parse the rest as a comma/whitespace-separated list of page numbers.
//
// A trailing `*` on the catalog token (e.g. `268-RT*`) is stripped — these
// are footnote markers in the source, not part of the warehouse SKU.
const CELL_SPLIT = /\s{2,}/;
const CATALOG_TOKEN_RE = /^#?[A-Z0-9][A-Z0-9-]*\*?$/i;

function parseIndexCell(cell: string): { catalogNumber: string; pageNumbers: number[] } | null {
  const trimmed = cell.trim();
  if (!trimmed) return null;
  const m = /^(\S+)\s+(.+)$/.exec(trimmed);
  if (!m) return null;
  const rawCatalog = m[1]!;
  if (!CATALOG_TOKEN_RE.test(rawCatalog)) return null;
  const catalogNumber = rawCatalog.replace(/^#/, "").replace(/\*$/, "");
  // Skip pure-number "catalog numbers" of length 1 (almost certainly a stray
  // page number that landed in the catalog column).
  if (/^\d$/.test(catalogNumber)) return null;
  const pageNumbers = m[2]!
    .split(/[,\s]+/)
    .map(s => parseInt(s, 10))
    .filter(n => Number.isFinite(n) && n > 0 && n < 10_000);
  if (pageNumbers.length === 0) return null;
  return { catalogNumber, pageNumbers };
}

export function parseIndexText(indexText: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const line of indexText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(CELL_SPLIT);
    for (const cell of cells) {
      const entry = parseIndexCell(cell);
      if (!entry) continue;
      const existing = out.get(entry.catalogNumber);
      if (existing) {
        for (const p of entry.pageNumbers) {
          if (!existing.includes(p)) existing.push(p);
        }
      } else {
        out.set(entry.catalogNumber, [...entry.pageNumbers]);
      }
    }
  }
  return out;
}

// ── Per-entry enrichment ────────────────────────────────────────────────────
function findPageRangeRule(profile: VendorProfile, page: number): PageRangeRule | null {
  for (const rule of profile.pageRanges) {
    if (page >= rule.startPage && page <= rule.endPage) return rule;
  }
  return null;
}

function findSuffixRules(profile: VendorProfile, catalog: string): SuffixRule[] {
  const upper = catalog.toUpperCase();
  // Greedy-match: try longest suffixes first so `-DCI2` wins over `-DC`.
  const sorted = [...profile.suffixRules].sort((a, b) => b.suffix.length - a.suffix.length);
  const matched: SuffixRule[] = [];
  const consumed = new Set<string>();
  for (const rule of sorted) {
    const sfx = rule.suffix.toUpperCase();
    if (upper.endsWith(sfx) && !consumed.has(sfx)) {
      matched.push(rule);
      consumed.add(sfx);
      // Don't double-count overlapping suffixes (e.g. -DC after -DCI2).
      break;
    }
  }
  return matched;
}

function dedupeKeywords(kws: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of kws) {
    const t = k.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Extract a short description snippet from the body page, if the catalog
 * number appears verbatim. Pulls the first non-empty line on the page that
 * mentions the catalog and trims it to ~120 chars. Returns "" when no hit.
 */
function snippetFromPage(pageText: string | undefined, catalogNumber: string): string {
  if (!pageText) return "";
  const upper = catalogNumber.toUpperCase();
  const lines = pageText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.toUpperCase().includes(upper)) {
      // Prefer a sibling descriptive line; the catalog-only line is usually
      // a table cell with no description. If the line is the catalog plus a
      // few words, use it directly.
      const cleaned = line.replace(/\s+/g, " ").trim();
      if (cleaned.length > catalogNumber.length + 3 && cleaned.length <= 200) return cleaned;
    }
  }
  return "";
}

// ── Top-level driver ────────────────────────────────────────────────────────
export interface ParsePdfOptions {
  /** Pass `false` to skip body-page snippet extraction (faster, less accurate). */
  extractBodySnippets?: boolean;
}

export async function parseCatalogPdf(
  buf: Buffer,
  profile: VendorProfile,
  options: ParsePdfOptions = {},
): Promise<CatalogEntry[]> {
  const tmp = writeTempPdf(buf);
  try {
    // 1. Index pages → catalog # → primary pages.
    const indexText = pdftotextLayout(tmp, profile.indexPages.firstPage, profile.indexPages.lastPage);
    const indexMap = parseIndexText(indexText);

    // 2. Optionally extract whole-doc page text once for snippet lookup.
    let pageTexts: string[] | null = null;
    if (options.extractBodySnippets !== false) {
      const allText = pdftotextLayout(tmp);
      // pdftotext separates pages with form-feed `\f`. Index 0 = page 1.
      pageTexts = allText.split("\f");
    }

    // 3. Build entries.
    const entries: CatalogEntry[] = [];
    for (const [catalogNumber, pageNumbers] of indexMap) {
      const primaryPage = pageNumbers[0]!;
      const rangeRule = findPageRangeRule(profile, primaryPage);
      const suffixRules = findSuffixRules(profile, catalogNumber);

      const dimensions: Record<string, string> = {};
      if (rangeRule) Object.assign(dimensions, rangeRule.dimensions);
      for (const sr of suffixRules) Object.assign(dimensions, sr.dimensions);

      const keywords = dedupeKeywords([
        profile.displayName.toLowerCase(),
        ...(rangeRule?.keywords ?? []),
        ...suffixRules.flatMap(s => s.keywords),
        ...Object.values(dimensions).map(v => v.toLowerCase()),
      ]);

      const snippet = pageTexts ? snippetFromPage(pageTexts[primaryPage - 1], catalogNumber) : "";
      const label = rangeRule?.label ?? "Catalog item";
      const description = snippet || `${label} ${catalogNumber}`;

      entries.push({
        catalogNumber,
        pageNumbers,
        description,
        dimensions,
        keywords,
      });
    }
    return entries;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(tmp)); } catch { /* ignore */ }
  }
}
