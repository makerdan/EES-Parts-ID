/**
 * Vendor catalog PDF parser.
 *
 * Two parsing strategies are supported, picked per-profile:
 *
 *   strategy: "index" (e.g. Bridgeport Fittings)
 *     1. Run `pdftotext -layout` on the buffer and split on form-feed `\f`
 *        to get per-page text.
 *     2. Locate the vendor's "INDEX BY CATALOG NUMBER" pages, split each
 *        line on multi-space gaps to recover the original column cells, and
 *        parse each cell as `<catalog-token> <page1>, <page2>, …`.
 *     3. Map the primary referenced page through the vendor's
 *        page-range → dimension table to seed chip dimensions.
 *
 *   strategy: "vendor-section" (e.g. Arlington / Crouse-Hinds via the
 *   Elliott Electric Supply distributor catalog)
 *     1. Walk every page looking for "Vendor Code: <CODE>" markers, where
 *        <CODE> identifies the manufacturer within a multi-vendor body
 *        page (e.g. "ARL" → Arlington Industries).
 *     2. Determine the column band each marker owns by finding the next
 *        marker to its right (right edge) and the next marker below it in
 *        the same column (bottom edge).
 *     3. Within that band, treat the first whitespace-separated token of
 *        every subsequent line as a candidate catalog number, filtering out
 *        prices, pure quantities, and obvious header words.
 *     4. Apply the same page-range → dimension and suffix → dimension
 *        enrichment as the index strategy.
 *
 * Both strategies emit the same `CatalogEntry` shape so downstream
 * matching/apply code is strategy-agnostic. Body-page snippet extraction is
 * also shared.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

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

interface VendorProfileBase {
  /** Canonical vendor code stored in the inventory.vendor column (uppercased). */
  vendor: string;
  /** Human-readable display name (e.g. "Bridgeport Fittings"). */
  displayName: string;
  /**
   * Optional multi-word brand aliases (e.g. "bridgeport fittings") that must
   * be preserved whole in the keyword list. Unlike `displayName` these are
   * added verbatim and are not split further by the tokenisation pipeline.
   */
  compoundAliases?: string[];
  /** Page-range → dimension mapping derived from the catalog table of contents. */
  pageRanges: PageRangeRule[];
  /** Catalog-suffix → dimension mapping (color codes etc.). */
  suffixRules: SuffixRule[];
  /** Hint shown in the vendor picker for which PDF this profile expects. */
  sourceCatalog: string;
}

export interface IndexVendorProfile extends VendorProfileBase {
  strategy: 'index';
  /** Pages (1-indexed) that contain the "INDEX BY CATALOG NUMBER" listing. */
  indexPages: { firstPage: number; lastPage: number };
}

export interface VendorSectionProfile extends VendorProfileBase {
  strategy: 'vendor-section';
  /**
   * "Vendor Code: <CODE>" marker to scan for on body pages of a distributor
   * catalog (e.g. "ARL" for Arlington Industries inside the EES catalog).
   */
  sourceVendorCode: string;
}

export type VendorProfile = IndexVendorProfile | VendorSectionProfile;

// ── Bridgeport 2026 profile ──────────────────────────────────────────────────
//
// Page ranges below come from the table of contents on pages 6-7 of
// `attached_assets/Bridgeport_Fittings_2026_Catalog_Part1_*.pdf`.
export const BRIDGEPORT_PROFILE: IndexVendorProfile = {
  vendor: 'BRIDGEPORT',
  displayName: 'Bridgeport',
  compoundAliases: ['bridgeport fittings'],
  strategy: 'index',
  sourceCatalog: 'Bridgeport Fittings 2026 Catalog',
  indexPages: { firstPage: 8, lastPage: 19 },
  pageRanges: [
    {
      startPage: 30,
      endPage: 41,
      dimensions: { category: 'Fitting' },
      keywords: ['solar', 'fitting'],
      label: 'Solar Fitting',
    },
    {
      startPage: 40,
      endPage: 55,
      dimensions: { category: 'Fitting', conduitType: 'RMC' },
      keywords: ['rigid', 'imc', 'conduit body'],
      label: 'RMC/IMC Conduit Body',
    },
    {
      startPage: 56,
      endPage: 63,
      dimensions: { category: 'Fitting', conduitType: 'EMT' },
      keywords: ['emt', 'conduit body'],
      label: 'EMT Conduit Body',
    },
    {
      startPage: 64,
      endPage: 105,
      dimensions: { category: 'Fitting', conduitType: 'RMC' },
      keywords: ['rigid', 'imc', 'fitting'],
      label: 'RMC/IMC Fitting',
    },
    {
      startPage: 106,
      endPage: 137,
      dimensions: { category: 'Fitting', conduitType: 'EMT' },
      keywords: ['emt', 'fitting'],
      label: 'EMT Fitting',
    },
    {
      startPage: 138,
      endPage: 143,
      dimensions: { category: 'Fitting', conduitType: 'EMT' },
      keywords: ['emt', 'fitting', 'color coded'],
      label: 'Color Coded EMT Fitting',
    },
    {
      startPage: 144,
      endPage: 155,
      dimensions: { category: 'Fitting', conduitType: 'LFMC' },
      keywords: ['liquid tight', 'fitting'],
      label: 'Liquid Tight Fitting',
    },
    {
      startPage: 156,
      endPage: 171,
      dimensions: { category: 'Fitting', environment: 'Wet' },
      keywords: ['raintight', 'fitting'],
      label: 'Raintight Fitting',
    },
    {
      startPage: 172,
      endPage: 183,
      dimensions: { category: 'Fitting' },
      keywords: ['bushing'],
      label: 'Bushing',
    },
    {
      startPage: 184,
      endPage: 199,
      dimensions: { category: 'Fitting' },
      keywords: ['snap-in', 'fitting'],
      label: 'Snap-In Fitting',
    },
    {
      startPage: 200,
      endPage: 225,
      dimensions: { category: 'Fitting', conduitType: 'FMC' },
      keywords: ['fmc', 'flexible metal', 'fitting'],
      label: 'FMC Fitting',
    },
    {
      startPage: 226,
      endPage: 259,
      dimensions: { category: 'Connector', wireType: 'MC' },
      keywords: ['armored', 'metal clad', 'ac', 'mc', 'fitting'],
      label: 'Armored / MC Cable Fitting',
    },
    {
      startPage: 260,
      endPage: 269,
      dimensions: { category: 'Fitting' },
      keywords: ['transition', 'fitting'],
      label: 'Transition Fitting',
    },
    {
      startPage: 270,
      endPage: 281,
      dimensions: { category: 'Connector' },
      keywords: ['nm', 'nonmetallic', 'portable cord', 'fitting'],
      label: 'Nonmetallic Cable / Cord Fitting',
    },
    {
      startPage: 282,
      endPage: 319,
      dimensions: { category: 'Connector' },
      keywords: ['cord grip', 'cable gland'],
      label: 'Cord Grip / Cable Gland',
    },
    {
      startPage: 320,
      endPage: 323,
      dimensions: { category: 'Fitting' },
      keywords: ['drain', 'vent'],
      label: 'Drain Fitting / Vent',
    },
    {
      startPage: 324,
      endPage: 337,
      dimensions: { category: 'Connector' },
      keywords: ['grounding', 'ground'],
      label: 'Grounding Product',
    },
    {
      startPage: 338,
      endPage: 353,
      dimensions: { category: 'Fitting', mountingType: 'Surface' },
      keywords: ['strap', 'clamp', 'hanger'],
      label: 'Strap / Clamp / Hanger',
    },
    {
      startPage: 354,
      endPage: 367,
      dimensions: { category: 'Fitting' },
      keywords: ['service entrance'],
      label: 'Service Entrance Fitting',
    },
    {
      startPage: 368,
      endPage: 386,
      dimensions: {},
      keywords: ['voice', 'data', 'fire alarm', 'specialty'],
      label: 'Voice / Data / Fire Alarm Fitting',
    },
  ],
  // Color codes from the Color Coded EMT Fittings section (pages 138-143).
  // Bridgeport uses single-letter color codes after `-S`, e.g. `231-SR`.
  suffixRules: [
    { suffix: '-SBLK', dimensions: { colorChip: 'Black' }, keywords: ['black'] },
    { suffix: '-SBLU', dimensions: { colorChip: 'Blue' }, keywords: ['blue'] },
    { suffix: '-SG', dimensions: { colorChip: 'Gray' }, keywords: ['gray'] },
    { suffix: '-SR', dimensions: { colorChip: 'Red' }, keywords: ['red'] },
    { suffix: '-SW', dimensions: { colorChip: 'White' }, keywords: ['white'] },
    { suffix: '-SY', dimensions: { colorChip: 'Yellow' }, keywords: ['yellow'] },
    { suffix: '-SO', dimensions: { colorChip: 'Orange' }, keywords: ['orange'] },
    { suffix: '-I', dimensions: {}, keywords: ['insulated'] },
    { suffix: '-DCI2', dimensions: {}, keywords: ['die cast', 'insulated'] },
    { suffix: '-DC2', dimensions: {}, keywords: ['die cast'] },
    { suffix: '-DC', dimensions: {}, keywords: ['die cast'] },
    { suffix: '-MB', dimensions: {}, keywords: ['malleable'] },
    { suffix: '-RT', dimensions: { environment: 'Wet' }, keywords: ['raintight'] },
    { suffix: '-LT', dimensions: { conduitType: 'LFMC' }, keywords: ['liquid tight'] },
  ],
};

// ── Distributor (Elliott Electric Supply) vendor-section profiles ────────────
//
// EES is a distributor; each body page may stack multiple manufacturer
// columns. Every column is introduced by a `Vendor Code: <CODE>` marker.
// We pin a profile to a single CODE and let the vendor-section parser
// extract that column's catalog tokens.
//
// Page ranges are coarse — they map sections (D = Wire & Cable, E =
// Conduit/Fittings/Boxes, I = Harsh Locations) to the most common item
// category in that section. Body-text snippets handle the per-row detail.

const EES_SOURCE = 'Elliott Electric Supply Product Catalog (06.2025)';

export const ARLINGTON_PROFILE: VendorSectionProfile = {
  vendor: 'ARLINGTON',
  displayName: 'Arlington Industries',
  strategy: 'vendor-section',
  sourceCatalog: EES_SOURCE,
  sourceVendorCode: 'ARL',
  pageRanges: [
    {
      startPage: 95,
      endPage: 108,
      dimensions: { category: 'Connector' },
      keywords: ['nm', 'nonmetallic', 'cable', 'connector'],
      label: 'NM Cable Connector',
    },
    {
      startPage: 109,
      endPage: 165,
      dimensions: { category: 'Fitting' },
      keywords: ['fitting', 'box'],
      label: 'Conduit / Box Fitting',
    },
  ],
  suffixRules: [
    { suffix: 'AST', dimensions: {}, keywords: ['snap-in'] },
    { suffix: 'DC2', dimensions: {}, keywords: ['die cast'] },
  ],
};

export const CROUSE_HINDS_PROFILE: VendorSectionProfile = {
  vendor: 'CROUSE-HINDS',
  displayName: 'Eaton Crouse-Hinds Series',
  strategy: 'vendor-section',
  sourceCatalog: EES_SOURCE,
  sourceVendorCode: 'CRS',
  pageRanges: [
    {
      startPage: 95,
      endPage: 108,
      dimensions: { category: 'Connector' },
      keywords: ['cable', 'connector'],
      label: 'Cable Connector',
    },
    {
      startPage: 109,
      endPage: 165,
      dimensions: { category: 'Fitting', conduitType: 'RMC' },
      keywords: ['rigid', 'fitting', 'condulet'],
      label: 'Conduit Body / Fitting',
    },
    {
      startPage: 180,
      endPage: 215,
      dimensions: { category: 'Fitting', environment: 'Hazardous' },
      keywords: ['explosion proof', 'hazardous', 'harsh location'],
      label: 'Hazardous Location Fitting',
    },
  ],
  suffixRules: [
    { suffix: 'DC', dimensions: {}, keywords: ['die cast'] },
    { suffix: 'SA', dimensions: {}, keywords: ['aluminum'] },
  ],
};

export const CANTEX_PROFILE: VendorSectionProfile = {
  vendor: 'CANTEX',
  displayName: 'Cantex, Inc.',
  strategy: 'vendor-section',
  sourceCatalog: EES_SOURCE,
  sourceVendorCode: 'PVF',
  pageRanges: [
    {
      startPage: 109,
      endPage: 165,
      dimensions: { category: 'Fitting', conduitType: 'PVC' },
      keywords: ['pvc', 'fitting'],
      label: 'PVC Fitting',
    },
  ],
  suffixRules: [
    { suffix: 'ELL90', dimensions: {}, keywords: ['elbow', '90 degree'] },
    { suffix: 'ELL45', dimensions: {}, keywords: ['elbow', '45 degree'] },
  ],
};

const VENDOR_PROFILES: Record<string, VendorProfile> = {
  BRIDGEPORT: BRIDGEPORT_PROFILE,
  ARLINGTON: ARLINGTON_PROFILE,
  'CROUSE-HINDS': CROUSE_HINDS_PROFILE,
  CANTEX: CANTEX_PROFILE,
};

// Aliases: alternate spellings the picker / API may receive.
const VENDOR_ALIASES: Record<string, string> = {
  'BRIDGEPORT FITTINGS': 'BRIDGEPORT',
  ARLINGTON_INDUSTRIES: 'ARLINGTON',
  'ARLINGTON INDUSTRIES': 'ARLINGTON',
  'CROUSE HINDS': 'CROUSE-HINDS',
  'EATON CROUSE-HINDS': 'CROUSE-HINDS',
  'EATON CROUSE HINDS': 'CROUSE-HINDS',
  CRS: 'CROUSE-HINDS',
  'CANTEX INC': 'CANTEX',
  'CANTEX, INC.': 'CANTEX',
};

export function getVendorProfile(vendor: string): VendorProfile | null {
  const norm = vendor.trim().toUpperCase();
  const canonical = VENDOR_ALIASES[norm] ?? norm;
  return VENDOR_PROFILES[canonical] ?? null;
}

export interface VendorOption {
  vendor: string;
  displayName: string;
  sourceCatalog: string;
}

/** Vendor list for the upload picker. Stable order: alphabetical by display name. */
export function listVendorProfiles(): VendorOption[] {
  return Object.values(VENDOR_PROFILES)
    .map((p) => ({ vendor: p.vendor, displayName: p.displayName, sourceCatalog: p.sourceCatalog }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ── pdftotext driver ────────────────────────────────────────────────────────
//
// poppler reads from disk (or stdin via "-"). We write the buffer to a
// tempfile so we can also page-slice with -f / -l on a second invocation if
// needed without re-passing 30+ MB through stdin.
function writeTempPdf(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-pdf-'));
  const file = path.join(dir, `${crypto.randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(file, buf);
  return file;
}

function pdftotextLayout(pdfPath: string, firstPage?: number, lastPage?: number): string {
  const args = ['-layout'];
  if (firstPage) args.push('-f', String(firstPage));
  if (lastPage) args.push('-l', String(lastPage));
  args.push(pdfPath, '-');
  return execFileSync('pdftotext', args, {
    encoding: 'utf-8',
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ── Index page parser (strategy: "index") ──────────────────────────────────
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
  const catalogNumber = rawCatalog.replace(/^#/, '').replace(/\*$/, '');
  // Skip pure-number "catalog numbers" of length 1 (almost certainly a stray
  // page number that landed in the catalog column).
  if (/^\d$/.test(catalogNumber)) return null;
  const pageNumbers = m[2]!
    .split(/[,\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 10_000);
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

// ── Vendor-section page parser (strategy: "vendor-section") ────────────────
//
// Distributor catalogs (e.g. Elliott Electric Supply) stack multiple
// manufacturer tables on the same body page, each introduced by a
// `Vendor Code: <CODE>` marker. We:
//   1. Find every marker on the page (line index + char column + code).
//   2. For each marker matching the target code, compute its column band:
//      - colLeft  = marker's character column.
//      - colRight = column of the nearest marker to its right (within a
//        few lines), else end-of-line.
//      - endLine  = line index of the nearest later marker that lands
//        inside the same column band, else end-of-page.
//   3. For every line strictly between marker and endLine, slice the
//      [colLeft, colRight) substring and take the first whitespace-split
//      token. If it looks like a catalog number, record it.
//
// Catalog token criteria are stricter than the index parser because the
// table cells contain prices, sizes, and quantities that must NOT be
// captured. Rules:
//   - Matches /^[A-Z0-9][A-Z0-9.\-/]{2,24}$/ (3-25 chars, alphanumeric + . - /)
//   - Contains at least one digit (rejects pure-letter header words).
//   - Is NOT pure decimal/numeric (rejects "879.00", "1815.28").
//   - Is NOT a 1-3 digit integer (rejects qty cells like "100", "25", "50").
//   - Is NOT in a small stop-word list of column headers / section labels.

const VENDOR_CODE_MARKER_RE = /Vendor Code:\s*([A-Z]+)/g;
const SECTION_TOKEN_RE = /^[A-Z0-9][A-Z0-9.\-/]{2,24}$/;

const VENDOR_SECTION_STOP_WORDS = new Set<string>([
  'CATALOG',
  'NUMBER',
  'SIZE',
  'PRICE',
  'DESCRIPTION',
  'EACH',
  'TYPE',
  'RIGID',
  'EMT',
  'PVC',
  'GALVANIZED',
  'BONDED',
  'COPPER',
  'GROUND',
  'RODS',
  'ALUMINUM',
  'STEEL',
  'DIE',
  'CAST',
  'SCREW',
  'UL',
  'LISTED',
  'INCLUDED',
  'NEOPRENE',
  'CARTON',
  'BUNDLE',
  'QTY',
  'QUANTITY',
  'PCS',
  'VENDOR',
  'CODE',
  'CTN',
  'HEAVY',
  'DUTY',
  'INSULATOR',
  'CLAMP',
  'CLAMPS',
  'BAG',
  'PIPE',
  'PLATE',
  'GROUNDING',
  'BONDING',
  'ROOF',
  'FLASHING',
  'KITS',
  'SWITCH',
  'DIMMER',
  'PER',
  'SECTION',
  'DIECAST',
  'MIDGET',
  'MEDIUM',
  'TOTAL',
  'CONDUIT',
  'FITTING',
  'FITTINGS',
  'BOX',
  'BOXES',
  'ITEM',
  'MODEL',
]);

function isVendorSectionToken(t: string): boolean {
  if (!t) return false;
  const upper = t.toUpperCase();
  if (!SECTION_TOKEN_RE.test(upper)) return false;
  if (!/[0-9]/.test(t)) return false;
  if (/^[0-9.,]+$/.test(t)) return false; // pure decimals (prices)
  if (/^[0-9]{1,3}$/.test(t)) return false; // small integers (quantities)
  if (VENDOR_SECTION_STOP_WORDS.has(upper)) return false;
  return true;
}

interface VendorMarker {
  lineIndex: number;
  col: number;
  code: string;
}

function findVendorMarkers(lines: readonly string[]): VendorMarker[] {
  const out: VendorMarker[] = [];
  for (let li = 0; li < lines.length; li++) {
    const re = new RegExp(VENDOR_CODE_MARKER_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[li]!)) !== null) {
      out.push({ lineIndex: li, col: m.index, code: m[1]! });
    }
  }
  return out;
}

export function parseVendorSectionPage(
  pageText: string,
  targetCode: string,
  pageNumber: number
): Array<{ catalogNumber: string; pageNumber: number }> {
  const lines = pageText.split('\n');
  const markers = findVendorMarkers(lines);
  if (markers.length === 0) return [];

  const out: Array<{ catalogNumber: string; pageNumber: number }> = [];
  const seen = new Set<string>();

  for (const mk of markers) {
    if (mk.code !== targetCode) continue;

    // Right boundary: nearest marker to the right whose line is within
    // ±60 of this marker's line (same physical table row band).
    let colRight = Number.POSITIVE_INFINITY;
    for (const other of markers) {
      if (other === mk) continue;
      if (other.col <= mk.col + 5) continue;
      if (other.lineIndex < mk.lineIndex - 1) continue;
      if (other.lineIndex > mk.lineIndex + 60) continue;
      if (other.col < colRight) colRight = other.col;
    }

    // Bottom boundary: nearest later marker landing inside our column band.
    let endLine = lines.length;
    for (const other of markers) {
      if (other === mk) continue;
      if (other.lineIndex <= mk.lineIndex) continue;
      if (other.col >= mk.col && other.col < colRight && other.lineIndex < endLine) {
        endLine = other.lineIndex;
      }
    }

    const sliceEnd = Number.isFinite(colRight) ? colRight : undefined;
    for (let li = mk.lineIndex + 1; li < endLine; li++) {
      const line = lines[li]!;
      const slice = line.slice(mk.col, sliceEnd);
      const first = slice.trim().split(/\s+/)[0];
      if (!first) continue;
      if (!isVendorSectionToken(first)) continue;
      const key = first.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ catalogNumber: key, pageNumber });
    }
  }

  return out;
}

function parseVendorSectionDoc(
  pageTexts: readonly string[],
  targetCode: string
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const marker = `Vendor Code: ${targetCode}`;
  for (let p = 0; p < pageTexts.length; p++) {
    const text = pageTexts[p]!;
    if (!text.includes(marker)) continue;
    const entries = parseVendorSectionPage(text, targetCode, p + 1);
    for (const e of entries) {
      const existing = out.get(e.catalogNumber);
      if (existing) {
        if (!existing.includes(e.pageNumber)) existing.push(e.pageNumber);
      } else {
        out.set(e.catalogNumber, [e.pageNumber]);
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
  if (!pageText) return '';
  const upper = catalogNumber.toUpperCase();
  const lines = pageText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.toUpperCase().includes(upper)) {
      // Prefer a sibling descriptive line; the catalog-only line is usually
      // a table cell with no description. If the line is the catalog plus a
      // few words, use it directly.
      const cleaned = line.replace(/\s+/g, ' ').trim();
      if (cleaned.length > catalogNumber.length + 3 && cleaned.length <= 200) return cleaned;
    }
  }
  return '';
}

// ── Top-level driver ────────────────────────────────────────────────────────
export interface ParsePdfOptions {
  /** Pass `false` to skip body-page snippet extraction (faster, less accurate). */
  extractBodySnippets?: boolean;
}

export async function parseCatalogPdf(
  buf: Buffer,
  profile: VendorProfile,
  options: ParsePdfOptions = {}
): Promise<CatalogEntry[]> {
  const tmp = writeTempPdf(buf);
  try {
    // Whole-doc text once: vendor-section needs every page; index strategy
    // also benefits because it reuses pageTexts for snippet extraction.
    const allText = pdftotextLayout(tmp);
    const pageTexts = allText.split('\f');

    // 1. Build catalog # → primary pages map per strategy.
    let indexMap: Map<string, number[]>;
    if (profile.strategy === 'index') {
      const indexText = pdftotextLayout(
        tmp,
        profile.indexPages.firstPage,
        profile.indexPages.lastPage
      );
      indexMap = parseIndexText(indexText);
    } else {
      indexMap = parseVendorSectionDoc(pageTexts, profile.sourceVendorCode);
    }

    const useSnippets = options.extractBodySnippets !== false;

    // 2. Build entries.
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
        ...(profile.compoundAliases?.map((a) => a.toLowerCase()) ?? []),
        ...(rangeRule?.keywords ?? []),
        ...suffixRules.flatMap((s) => s.keywords),
        ...Object.values(dimensions).map((v) => v.toLowerCase()),
      ]);

      const snippet = useSnippets ? snippetFromPage(pageTexts[primaryPage - 1], catalogNumber) : '';
      const label = rangeRule?.label ?? 'Catalog item';
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
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(path.dirname(tmp));
    } catch {
      /* ignore */
    }
  }
}
