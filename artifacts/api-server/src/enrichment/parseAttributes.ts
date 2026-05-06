/**
 * Pure, side-effect-free catalog/description attribute parsers.
 *
 * All functions take raw string inputs (catalog number, description, etc.)
 * and return typed values with no DB or network calls. They are safe to
 * unit-test in isolation and are called both from the backfill script and
 * from the real-time enrichment pipeline.
 *
 * Parser version is 2. Bump CURRENT_PARSER_VERSION in invalidation.ts
 * whenever these patterns change in a meaningful way.
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
  /** Parser version — always 2 for the current implementation. */
  parser_version: 2;
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
 */
const BREAKER_RE =
  /^(BR|QO|CH|HOM|THQL|MP|SWD|FH|HH|Q1)(1|2|3|4)(\d{2,3})(.*)?$/i;

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
      parser_version: 2,
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
      parser_version: 2,
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
      parser_version: 2,
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
      parser_version: 2,
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
  const m = text
    .toUpperCase()
    .match(/\b(\d{1,4})\s*[-]?\s*(?:A\b|AMPS?\b|AMPERES?\b)/);
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
  const VALID = new Set([12, 24, 48, 120, 127, 208, 220, 240, 277, 347, 380, 480, 600]);
  return VALID.has(n) ? n : null;
}

// ── Fraction / decimal table for free-text trade-size parsing ───────────────

const FRAC_MAP: Array<[RegExp, number]> = [
  [/\b7\/8\b/, 7 / 8],
  [/\b3\/4\b/, 3 / 4],
  [/\b5\/8\b/, 5 / 8],
  [/\b1\/2\b/, 1 / 2],
  [/\b3\/8\b/, 3 / 8],
  [/\b1\/4\b/, 1 / 4],
  [/\b1\/8\b/, 1 / 8],
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
  const mixedMatch = t.match(/\b(\d+)[\s-](\d+)\/(\d+)\b/);
  if (mixedMatch) {
    const whole = parseInt(mixedMatch[1]!, 10);
    const num = parseInt(mixedMatch[2]!, 10);
    const den = parseInt(mixedMatch[3]!, 10);
    if (den !== 0) {
      const val = whole + num / den;
      return val > 0 && val <= 12 ? val : null;
    }
  }

  // ── Simple fraction: "1/2", "3/4" ────────────────────────────────────────
  for (const [re, val] of FRAC_MAP) {
    if (re.test(t)) return val;
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
  if (/\bBOLT[-\s]ON\b/.test(t)) return "bolt-on";
  if (/\bPLUG[-\s]?IN\b|\bPLUGIN\b/.test(t)) return "plug-in";
  if (/\bDIN[-\s]?RAIL\b/.test(t)) return "din-rail";
  if (/\bSURFACE[-\s]?MOUNT\b|\bSURFACE\b/.test(t)) return "surface";
  if (/\bFLUSH[-\s]?MOUNT\b|\bFLUSH\b/.test(t)) return "flush";
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
  const fullText = [item.catalog, item.description].filter(Boolean).join(" ");

  const amperage =
    catalogParse?.amps ??
    parseAmperage(item.description) ??
    parseAmperage(item.catalog);

  const poleCount =
    catalogParse?.poles ??
    parsePoles(item.description) ??
    parsePoles(item.catalog);

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
