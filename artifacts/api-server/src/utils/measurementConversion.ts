/**
 * Cross-unit measurement conversion utility.
 *
 * Parses metric (mm, cm, m) and imperial (inch, foot) measurements from a
 * text string and returns an array of equivalent measurement terms in the
 * opposite unit system.  Results are suitable for injecting into search
 * query expansion or appending to aiKeywords for FTS/trigram matching.
 */

const MM_PER_INCH = 25.4;
const FT_PER_METER = 3.28084;

/**
 * Standard electrical / conduit trade sizes in decimal inches.
 * These are the values printed on conduit, fittings, and boxes in North
 * American electrical catalogues.
 */
const TRADE_SIZES: ReadonlyArray<{ inches: number; label: string }> = [
  { inches: 0.125, label: "1/8" },
  { inches: 0.25,  label: "1/4" },
  { inches: 0.375, label: "3/8" },
  { inches: 0.5,   label: "1/2" },
  { inches: 0.75,  label: "3/4" },
  { inches: 1.0,   label: "1" },
  { inches: 1.25,  label: "1-1/4" },
  { inches: 1.5,   label: "1-1/2" },
  { inches: 2.0,   label: "2" },
  { inches: 2.5,   label: "2-1/2" },
  { inches: 3.0,   label: "3" },
  { inches: 3.5,   label: "3-1/2" },
  { inches: 4.0,   label: "4" },
  { inches: 5.0,   label: "5" },
  { inches: 6.0,   label: "6" },
];

/** Format a number, removing trailing zeros after the decimal point. */
function fmt(n: number, dp: number): string {
  return n.toFixed(dp).replace(/\.?0+$/, "");
}

/**
 * Return the label of the nearest standard trade size if the given inch value
 * is within 5 % of that size, otherwise return null.
 */
function nearestTradeSize(inches: number): string | null {
  let best: { label: string; diff: number } | null = null;
  for (const ts of TRADE_SIZES) {
    const diff = Math.abs(ts.inches - inches);
    const pct = ts.inches > 0 ? diff / ts.inches : Infinity;
    if (pct <= 0.05) {
      if (!best || diff < best.diff) {
        best = { label: ts.label, diff };
      }
    }
  }
  return best?.label ?? null;
}

/** Produce metric-equivalent search terms for an inch value. */
function inchToMetricTerms(inches: number): string[] {
  // Pre-round to 2 dp to eliminate IEEE-754 noise (e.g. 0.75 * 25.4 = 19.0499...)
  const mm = Math.round(inches * MM_PER_INCH * 100) / 100;
  const mmStr = fmt(mm, 1);
  const mmInt = String(Math.round(mm));
  const terms: string[] = [`${mmStr}mm`, `${mmStr} mm`];
  if (mmInt !== mmStr) {
    terms.push(`${mmInt}mm`, `${mmInt} mm`);
  }
  return terms;
}

/** Produce imperial-equivalent search terms for a mm value. */
function mmToInchTerms(mm: number): string[] {
  const inches = mm / MM_PER_INCH;
  const inStr = fmt(inches, 3);
  const terms: string[] = [`${inStr} inch`, `${inStr}"`];
  const ts = nearestTradeSize(inches);
  if (ts) {
    terms.push(`${ts} inch`, `${ts}"`, `${ts} in`);
  }
  return terms;
}

/**
 * Parse `text` for any length measurements and return an array of converted
 * equivalent strings suitable for use as search or keyword terms.
 *
 * Conversions performed:
 *   mm  ↔  inch (decimal + nearest standard trade-size fraction)
 *   cm  →  inch (decimal + nearest standard trade-size fraction)
 *   m   ↔  ft   (decimal)
 *
 * Wire-gauge fractions (e.g. "14/2") are excluded because they never carry an
 * explicit inch-unit suffix in catalogue text.
 */
export function expandMeasurements(text: string): string[] {
  const extra = new Set<string>();

  // ── Metric → Imperial ──────────────────────────────────────────────────────

  // mm: "10mm", "25.4 mm"
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*mm\b/gi)) {
    const mm = parseFloat(m[1]!);
    if (mm > 0 && mm < 10_000) {
      for (const t of mmToInchTerms(mm)) extra.add(t);
    }
  }

  // cm: "2.54cm", "5 cm"
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*cm\b/gi)) {
    const mm = parseFloat(m[1]!) * 10;
    if (mm > 0 && mm < 10_000) {
      for (const t of mmToInchTerms(mm)) extra.add(t);
    }
  }

  // meters: "1.5m", "2 m" — but NOT "mm" (negative lookahead on next char)
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*m(?!m)\b/gi)) {
    const meters = parseFloat(m[1]!);
    const ft = meters * FT_PER_METER;
    if (ft > 0 && ft < 100_000) {
      const ftStr = fmt(ft, 2);
      const ftInt = String(Math.round(ft));
      extra.add(`${ftStr} ft`);
      extra.add(`${ftStr} feet`);
      if (ftInt !== ftStr) {
        extra.add(`${ftInt} ft`);
        extra.add(`${ftInt} feet`);
      }
    }
  }

  // ── Imperial → Metric ──────────────────────────────────────────────────────

  // Mixed fraction inch: "1-1/2"", "1-1/2 inch", "1 1/2""
  for (const m of text.matchAll(/\b(\d+)[-\s](\d+)\/(\d+)\s*(?:"|in(?:ch(?:es?)?)?\b)/gi)) {
    const den = parseInt(m[3]!);
    if (den > 0) {
      const inches = parseInt(m[1]!) + parseInt(m[2]!) / den;
      if (inches > 0 && inches <= 100) {
        for (const t of inchToMetricTerms(inches)) extra.add(t);
      }
    }
  }

  // Simple fraction inch with explicit unit: "1/2"", "3/4 inch"
  // Denominators limited to 2, 4, 8, 16 to exclude wire-gauge fractions (14/2 etc.)
  for (const m of text.matchAll(/(?<!\d)(\d{1,3})\/(\d{1,2})\s*(?:"|in(?:ch(?:es?)?)?\b)/gi)) {
    const num = parseInt(m[1]!);
    const den = parseInt(m[2]!);
    if ([2, 4, 8, 16].includes(den) && num > 0 && num < den * 10) {
      const inches = num / den;
      if (inches > 0 && inches <= 100) {
        for (const t of inchToMetricTerms(inches)) extra.add(t);
      }
    }
  }

  // Decimal inch: "0.394"", "0.5 inch", "1.5 in"
  for (const m of text.matchAll(/\b(\d+\.\d+)\s*(?:"|in(?:ch(?:es?)?)?\b)/gi)) {
    const inches = parseFloat(m[1]!);
    if (inches > 0 && inches <= 100) {
      for (const t of inchToMetricTerms(inches)) extra.add(t);
      // Also surface nearest trade size for plain decimal inch inputs
      const ts = nearestTradeSize(inches);
      if (ts) {
        extra.add(`${ts} inch`);
        extra.add(`${ts}"`);
      }
    }
  }

  // Feet → Meters: "10ft", "10 ft", "10 feet"
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:ft|feet|foot)\b/gi)) {
    const ftVal = parseFloat(m[1]!);
    const meters = ftVal / FT_PER_METER;
    if (meters > 0 && meters < 100_000) {
      const mStr = fmt(meters, 2);
      extra.add(`${mStr}m`);
      extra.add(`${mStr} m`);
    }
  }

  return Array.from(extra);
}
