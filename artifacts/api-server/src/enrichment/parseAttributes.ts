/**
 * Pure, side-effect-free catalog/description attribute parsers.
 *
 * All functions take raw string inputs (catalog number, description, etc.)
 * and return typed values with no DB or network calls. They are safe to
 * unit-test in isolation and are called both from the backfill script and
 * from the real-time enrichment pipeline.
 *
 * Parser version is 3. Bump CURRENT_PARSER_VERSION in invalidation.ts
 * whenever these patterns change in a meaningful way.
 *
 * v3 adds: expanded breaker series (BAB, GHB, CLCAF, BRN, GFCB, GFTCB,
 *          BJ, BJH, CHF), fuse pattern (Bussmann FNQ/LPCC/FRNR/LPJ/GMA/etc),
 *          extended numeric device range (4–5 digit Hubbell/Pass codes),
 *          generic alpha-numeric device fallback, and 125V/500V voltages.
 */

/** Structured parse of a catalog number. */
export interface CatalogParse {
  /** Product family / series prefix, e.g. "BR", "QO", "NM". */
  series: string;
  /** Pole count encoded in the catalog number (1–4), or null when absent. */
  poles: number | null;
  /** Amperage encoded in the catalog number, or null when absent. */
  amps: number | null;
  /**
   * Trailing suffix after the series/poles/amps portion, e.g. "PC", "WHI",
   * "AF". Null when the catalog number ends after the numeric section.
   */
  variant: string | null;
  /** The original catalog string passed to parseCatalog(). */
  raw: string;
  /** Parser version — always 3 for the current implementation. */
  parser_version: 3;
}

// ── Internal regex constants ────────────────────────────────────────────────

/**
 * Breaker family: SERIES + POLES(1 digit, 1-4) + AMPS(2-3 digits) + VARIANT
 *
 * Examples:
 *   BR120    → series=BR,   poles=1, amps=20,  variant=null
 *   QO220    → series=QO,   poles=2, amps=20,  variant=null
 *   CH3100   → series=CH,   poles=3, amps=100, variant=null
 *   HOM230   → series=HOM,  poles=2, amps=30,  variant=null
 *   THQL120  → series=THQL, poles=1, amps=20,  variant=null
 *   QO1100PC → series=QO,   poles=1, amps=100, variant=PC
 *   BAB2045  → series=BAB,  poles=2, amps=45,  variant=null
 *   BAB3090H → series=BAB,  poles=3, amps=90,  variant=H
 *   GHB3100  → series=GHB,  poles=3, amps=100, variant=null
 *   CLCAF120 → series=CLCAF,poles=1, amps=20,  variant=null
 *   BRN115GF → series=BRN,  poles=1, amps=15,  variant=GF
 *
 * Note: BD/BRD/BQ duplex/quad breakers use a different (1-50A/2P 1-50A/2P)
 *       layout that doesn't fit this pattern and are intentionally excluded.
 */
const BREAKER_RE =
  /^(BR|BRN|BAB|BJ|BJH|GHB|GHQ|CLCAF|GFCB|GFTCB|CHF|QO|CH|HOM|THQL|MP|SWD|FH|HH|Q1)(1|2|3|4)(\d{2,3})(.*)?$/i;

/**
 * Receptacle / device family: SERIES + AMPS(2-3 digits) + VARIANT(color etc.)
 *
 * Examples:
 *   DR15WHI  → series=DR, amps=15, variant=WHI
 *   CR20BLK  → series=CR, amps=20, variant=BLK
 *   TR15     → series=TR, amps=15, variant=null
 *   GF20     → series=GF, amps=20, variant=null
 *   WR20     → series=WR, amps=20, variant=null
 */
const DEVICE_RE = /^(DR|CR|TR|GF|WR)(\d{2,3})(.*)?$/i;

/**
 * Wire / cable family: SERIES + spec-string (gauge, conductor count, length).
 * Poles and amps are not extracted because they would be misinterpreted.
 *
 * Examples:
 *   NM214100FT  → series=NM,   variant=214100FT
 *   MC121250FT  → series=MC,   variant=121250FT
 *   THHN12      → series=THHN, variant=12
 *   THWN10      → series=THWN, variant=10
 */
const CABLE_RE = /^(RX|NM|MC|SE|SER|UF|THHN|THWN)(\d.*)?$/i;

/**
 * Transformer family: V{VA}M{W} format.
 *
 * Examples:
 *   V100M50    → series=V100M50, variant=null
 *   V500M250T  → series=V500M250, variant=T
 */
const XFMR_RE = /^(V\d+M\d+)(T.*)?$/i;

/**
 * Numeric device family (Hubbell, Leviton, Pass & Seymour, and similar):
 * 4-digit codes starting with 5 or 6, OR 5-digit codes starting with 5 or 6
 * (covers Hubbell weatherproof box codes like 53320, 51730, 56060), optionally
 * followed by a variant suffix.
 *
 * This mirrors the `5\d{3}|6\d{3}` branch in `getSeriesBase()` so that
 * parseCatalog covers the same catalog families for materialized lookup.
 *
 * Examples:
 *   5262WHI  → series=5262,  variant=WHI
 *   6150GRY  → series=6150,  variant=GRY
 *   5262     → series=5262,  variant=null
 *   5325I    → series=5325,  variant=I
 *   53320    → series=53320, variant=null  (Hubbell WP box)
 *   51730    → series=51730, variant=null
 */
const NUMERIC_DEVICE_RE = /^([56]\d{3,4})([-A-Z].*)?\s*$/i;

/**
 * Bussmann fuse family: SERIES + AMPS(1-3 digits) + optional class/variant.
 *
 * Examples:
 *   FNQ15    → series=FNQ,  amps=15,  variant=null
 *   LPCC15   → series=LPCC, amps=15,  variant=null
 *   FRNR250  → series=FRNR, amps=250, variant=null
 *   LPJ35SP  → series=LPJ,  amps=35,  variant=SP
 *   FNM4     → series=FNM,  amps=4,   variant=null
 *   GMA4R    → series=GMA,  amps=4,   variant=R
 */
const FUSE_RE =
  /^(FNQ|FNM|FNW|LPCC|LPJ|LPN|LPS|FRNR|FRSR|GMA|AGC|AGU|MDA|MDL|KTK|KLDR|JKS|FWP|FWX|KAS|KAR)(\d{1,3})([A-Z][A-Z0-9-]{0,8})?\s*$/i;

/**
 * Generic alpha-prefix device fallback: 1-5 letters + 3-5 digits + optional
 * trailing letter/digit variant. Catches Pass & Seymour, Bryant, Lutron, and
 * other vendor catalogs that don't match a more specific family pattern.
 *
 * Amps and poles are NOT extracted because the digit segment is ambiguous
 * (could be a model number, color code, or wattage). This pattern only
 * populates `series`, which is still useful for grouping and series-based
 * "other variants" lookups.
 *
 * Examples:
 *   1226I       → series=1226,    variant=I    (Pass & Seymour switch)
 *   885BK       → series=885,     variant=BK   (Pass duplex receptacle)
 *   PD6ANSWH    → series=PD,      variant=...  (Lutron Caseta dimmer)
 *   MRF2S6ELV120WH (matched but limited) — series=MRF; rest is variant.
 *
 * Excludes catalogs that already matched stricter patterns above.
 */
const ALPHA_DEVICE_RE = /^([A-Z]{0,5})(\d{3,5})([A-Z][A-Z0-9-]{0,12})?\s*$/i;

// ── Public parsers ──────────────────────────────────────────────────────────

/**
 * Parse a catalog number into its structured components.
 *
 * Returns null when the catalog string is empty or doesn't match any
 * known pattern. The caller should store null verbatim in catalog_parse
 * (meaning "no structured parse available") rather than an empty object.
 */
export function parseCatalog(catalog: string | null | undefined): CatalogParse | null {
  if (!catalog) return null;
  const c = catalog.trim();
  if (!c) return null;
  const cu = c.toUpperCase();

  const breaker = BREAKER_RE.exec(cu);
  if (breaker) {
    return {
      series: breaker[1]!,
      poles: parseInt(breaker[2]!, 10),
      amps: parseInt(breaker[3]!, 10),
      variant: breaker[4] || null,
      raw: c,
      parser_version: 3,
    };
  }

  const device = DEVICE_RE.exec(cu);
  if (device) {
    return {
      series: device[1]!,
      poles: null,
      amps: parseInt(device[2]!, 10),
      variant: device[3] || null,
      raw: c,
      parser_version: 3,
    };
  }

  const cable = CABLE_RE.exec(cu);
  if (cable) {
    return {
      series: cable[1]!,
      poles: null,
      amps: null,
      variant: cable[2] || null,
      raw: c,
      parser_version: 3,
    };
  }

  const xfmr = XFMR_RE.exec(cu);
  if (xfmr) {
    return {
      series: xfmr[1]!,
      poles: null,
      amps: null,
      variant: xfmr[2] || null,
      raw: c,
      parser_version: 3,
    };
  }

  const numDev = NUMERIC_DEVICE_RE.exec(cu);
  if (numDev) {
    return {
      series: numDev[1]!,
      poles: null,
      amps: null,
      variant: numDev[2]?.replace(/^-/, '') || null,
      raw: c,
      parser_version: 3,
    };
  }

  const fuse = FUSE_RE.exec(cu);
  if (fuse) {
    const amps = parseInt(fuse[2]!, 10);
    return {
      series: fuse[1]!,
      poles: null,
      amps: amps >= 1 && amps <= 6000 ? amps : null,
      variant: fuse[3] || null,
      raw: c,
      parser_version: 3,
    };
  }

  // Generic alpha-numeric fallback. Lower priority than every pattern above.
  // Only matches when the catalog has both a letter prefix (or is purely
  // numeric ≥ 3 digits) and a digit segment — preventing false positives on
  // pure-letter catalogs while still catching Pass/Bryant/Lutron-style codes.
  const alpha = ALPHA_DEVICE_RE.exec(cu);
  if (alpha) {
    const prefix = alpha[1] || '';
    const digits = alpha[2]!;
    // Skip purely-numeric matches < 4 digits (too generic — catches PO numbers,
    // box counts, etc.). 4-5 digit numerics are handled by NUMERIC_DEVICE_RE
    // above when starting with 5 or 6; allow others here.
    if (!prefix && digits.length < 4) return null;
    return {
      series: prefix ? `${prefix}${digits}` : digits,
      poles: null,
      amps: null,
      variant: alpha[3] || null,
      raw: c,
      parser_version: 3,
    };
  }

  return null;
}

/**
 * Extract amperage from any free-text string (catalog or description).
 *
 * Recognizes: "20A", "20 A", "20AMP", "20 AMP", "20AMPS", "20-AMP",
 *             "20 AMPERE", "20 AMPERES". Returns null when no valid
 *             amperage pattern is found or the value is out of range.
 */
export function parseAmperage(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.toUpperCase().match(/\b(\d{1,4})\s*[-]?\s*(?:A\b|AMPS?\b|AMPERES?\b)/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return n >= 1 && n <= 6000 ? n : null;
}

/**
 * Extract pole count from any free-text string (catalog or description).
 *
 * Recognizes: "1P", "1-P", "1POLE", "1-POLE", "1 POLE", "SINGLE POLE",
 *             "2P", "DP", "DOUBLE POLE", "TWO POLE", "TWO-POLE",
 *             "3P", "TP", "THREE POLE", "4P", "FOUR POLE".
 * Returns null when no pole indicator is detected.
 */
export function parsePoles(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toUpperCase();

  if (/\bFOUR[-\s]?POLE\b|\b4[-\s]?P(?:OLE)?\b/.test(t)) return 4;
  if (/\bTHREE[-\s]?POLE\b|\bT\.?P\.?\b|\b3[-\s]?P(?:OLE)?\b/.test(t)) return 3;
  if (/\bDOUBLE[-\s]?POLE\b|\bD\.?P\.?\b|\bTWO[-\s]?POLE\b|\b2[-\s]?P(?:OLE)?\b/.test(t)) return 2;
  if (/\bSINGLE[-\s]?POLE\b|\b1[-\s]?P(?:OLE)?\b/.test(t)) return 1;

  return null;
}

/**
 * Extract voltage from any free-text string (catalog or description).
 *
 * Recognizes patterns like "120V", "240VAC", "277 V", "120/240V"
 * (first voltage wins). Only returns values that are recognized
 * standard electrical voltages (12–600 V).
 */
export function parseVoltage(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.toUpperCase().match(/\b(\d{2,3})\s*(?:\/\d+)?\s*V(?:AC|DC)?\b/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const VALID = new Set([
    12, 24, 48, 120, 125, 127, 208, 220, 240, 250, 277, 347, 380, 480, 500, 600,
  ]);
  return VALID.has(n) ? n : null;
}

// ── Fraction / decimal table for free-text trade-size parsing ───────────────

// Use digit-negative lookahead/lookbehind instead of \b so that fractions
// followed immediately by a letter (e.g. "3/4X90", "1/2EMT") are still
// recognised.  A plain \b after the denominator fails when the next character
// is a word character like "X" or "L".
//
// The lookbehind also excludes a preceding dash so that degree-angle
// specifications like "22-1/2D" (meaning 22.5°, not the trade size 1/2")
// are not misinterpreted.  The mixed-number branch above already handles
// legitimate "1-1/2"" patterns before this FRAC_MAP is reached.
const FRAC_MAP: Array<[RegExp, number]> = [
  [/(?<![\d-])7\/8(?!\d)/, 7 / 8],
  [/(?<![\d-])3\/4(?!\d)/, 3 / 4],
  [/(?<![\d-])5\/8(?!\d)/, 5 / 8],
  [/(?<![\d-])1\/2(?!\d)/, 1 / 2],
  [/(?<![\d-])3\/8(?!\d)/, 3 / 8],
  [/(?<![\d-])1\/4(?!\d)/, 1 / 4],
  [/(?<![\d-])1\/8(?!\d)/, 1 / 8],
];

/**
 * Parse a trade size from a free-text string, returning the value in inches.
 *
 * Handles:
 *   - Fractions:        "1/2"", "3/4 inch"
 *   - Mixed numbers:    "1 1/2"", "2-1/2 in", "1-1/4""
 *   - Decimals:         "0.5 in", "2.5""
 *   - Whole numbers:    "2 inch", "3 in"
 *   - mm suffix:        "25mm", "50 mm" (converted via ÷ 25.4)
 *
 * Returns null when no recognizable trade-size pattern is found or the
 * resulting value is outside the plausible conduit range (0 < x ≤ 12).
 */
export function parseTradeSize(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;

  // ── mm suffix ────────────────────────────────────────────────────────────
  const mmMatch = t.match(/\b(\d+(?:\.\d+)?)\s*mm\b/i);
  if (mmMatch) {
    const val = parseFloat(mmMatch[1]!) / 25.4;
    return val > 0 && val <= 12 ? Math.round(val * 1000) / 1000 : null;
  }

  // ── Mixed number: "1 1/2", "2-1/2", "1-1/4" ─────────────────────────────
  // Use (?!\d) instead of \b at the end so "1-1/2X90" is still matched
  // (the trailing "X" is a word character, so \b would fail there).
  // Guard: only use the match when the whole-number part is ≤ 12; otherwise
  // the regex can misfire on schedule/gauge numbers preceding a fraction, e.g.
  // "SCH 80 3/4"" → "80 3/4" → 80.75 (nonsensical), which would block the
  // simpler FRAC_MAP from finding "3/4" → 0.75.
  const mixedMatch = t.match(/\b(\d+)[\s-](\d+)\/(\d+)(?!\d)/);
  if (mixedMatch) {
    const whole = parseInt(mixedMatch[1]!, 10);
    const num = parseInt(mixedMatch[2]!, 10);
    const den = parseInt(mixedMatch[3]!, 10);
    if (den !== 0 && whole <= 12) {
      const val = whole + num / den;
      if (val > 0 && val <= 12) return val;
    }
  }

  // ── Simple fraction: "1/2", "3/4" ────────────────────────────────────────
  for (const [re, val] of FRAC_MAP) {
    if (re.test(t)) return val;
  }

  // ── N×angle format: "1X90", "2 X 90", "4X45" ────────────────────────────
  // Conduit elbows are often described as <size>X<bend-angle> (e.g. "2X90
  // AL STANDARD ELBOW"). When the second number is a recognisable bend angle
  // (≥ 15°), treat the first number as the trade size. Checked before the
  // inch-suffix pattern so "2 X 90*D LRG 24" RADIUS ELBOW" returns 2 rather
  // than failing on the out-of-range "24"" later in the string.
  const nxAngleMatch = t.match(/\b(\d+(?:\.\d+)?)\s*[Xx]\s*(\d+)/);
  if (nxAngleMatch) {
    const angle = parseInt(nxAngleMatch[2]!, 10);
    if (angle >= 15) {
      const val = parseFloat(nxAngleMatch[1]!);
      if (val > 0 && val <= 12) return val;
    }
  }

  // ── Decimal or whole number with inch suffix ─────────────────────────────
  // Note: \b only follows word tokens (in/inch/inches), not the " mark itself.
  const decMatch = t.match(/\b(\d+(?:\.\d+)?)\s*(?:"|(?:in\.?|inch(?:es)?)\b)/i);
  if (decMatch) {
    const val = parseFloat(decMatch[1]!);
    return val > 0 && val <= 12 ? val : null;
  }

  return null;
}

/**
 * Extract mounting type from any free-text string.
 *
 * Returns one of: "bolt-on" | "plug-in" | "din-rail" | "surface" | "flush"
 * or null when no pattern is matched.
 */
export function parseMountType(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toUpperCase();
  if (/\bBOLT[-\s]ON\b/.test(t)) return 'bolt-on';
  if (/\bPLUG[-\s]?IN\b|\bPLUGIN\b/.test(t)) return 'plug-in';
  if (/\bDIN[-\s]?RAIL\b/.test(t)) return 'din-rail';
  if (/\bSURFACE[-\s]?MOUNT\b|\bSURFACE\b/.test(t)) return 'surface';
  if (/\bFLUSH[-\s]?MOUNT\b|\bFLUSH\b/.test(t)) return 'flush';
  return null;
}

/**
 * Derive all materialized attribute columns for a single inventory item.
 *
 * Returns a plain object that can be passed directly to a Drizzle `.set()`
 * call. The `attrsParsedAt` timestamp is always the current time.
 */
export function deriveAttrs(item: {
  catalog: string | null;
  description: string | null;
  vendor?: string | null;
}): {
  catalogParse: CatalogParse | null;
  amperage: number | null;
  poleCount: number | null;
  voltage: number | null;
  mountType: string | null;
  attrsParsedAt: Date;
} {
  const catalogParse = parseCatalog(item.catalog);
  const fullText = [item.catalog, item.description].filter(Boolean).join(' ');

  const amperage =
    catalogParse?.amps ?? parseAmperage(item.description) ?? parseAmperage(item.catalog);

  const poleCount = catalogParse?.poles ?? parsePoles(item.description) ?? parsePoles(item.catalog);

  const voltage = parseVoltage(item.description) ?? parseVoltage(item.catalog);

  const mountType = parseMountType(fullText);

  return {
    catalogParse,
    amperage,
    poleCount,
    voltage,
    mountType,
    attrsParsedAt: new Date(),
  };
}
