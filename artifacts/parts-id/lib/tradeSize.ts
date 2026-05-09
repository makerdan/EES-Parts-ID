/**
 * Pure helpers for parsing trade-size diameters out of conduit/pipe catalog
 * codes so the default search-result order can sort small → large when no
 * other order is requested by the user.
 *
 * Convention used by the warehouse's catalog scheme:
 *   - Trailing digits on a catalog code encode trade size in inches.
 *   - A 2-digit fraction code (12=1/2, 34=3/4, 14=1/4, 38=3/8, 58=5/8,
 *     78=7/8, 18=1/8) is appended after an optional whole-inch prefix:
 *       IMC12   → 1/2"      EMT34  → 3/4"
 *       IMC212  → 2 1/2"    EMT114 → 1 1/4"
 *       EMT112  → 1 1/2"
 *   - Pure whole-inch sizes appear either as zero-padded hundreds
 *     (100 = 1", 200 = 2", 400 = 4") or as a small bare integer (1 = 1",
 *     2 = 2"). We accept both since either form shows up across vendors.
 *
 * Lives in its own file with no React Native imports so it can be unit
 * tested under Jest's pure node environment.
 */

const FRACTION_CODES: Record<string, number> = {
  '18': 1 / 8,
  '14': 1 / 4,
  '38': 3 / 8,
  '12': 1 / 2,
  '58': 5 / 8,
  '34': 3 / 4,
  '78': 7 / 8,
};

/**
 * Decimal × 100 codes used by some vendors (e.g. "EMT150" = 1.50" = 1-1/2",
 * "EMT250" = 2.50" = 2-1/2", "EMT75" = 0.75" = 3/4").
 *
 * Checked after FRACTION_CODES so that the fraction encoding (e.g. "12" for
 * 1/2) always wins. Only the three quarter-inch boundary values are needed
 * because "00" (whole inches) is already handled by the n%100===0 path.
 */
const DECIMAL_CODES: Record<string, number> = {
  '25': 0.25,
  '50': 0.5,
  '75': 0.75,
};

/**
 * Parse a trade-size diameter (in inches) from the trailing digits of a
 * catalog code or short description. Returns null when no recognizable
 * size is present so callers can fall back to whatever default order the
 * server returned.
 */
export function parseTradeSizeInches(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.toUpperCase().match(/(\d+)\s*$/);
  if (!m) return null;
  const digits = m[1]!;

  // Two-digit fraction with optional leading whole part: e.g. "212" → 2 1/2.
  if (digits.length >= 2) {
    const tail = digits.slice(-2);

    // Fraction-code encoding wins (e.g. "12"→0.5, "34"→0.75, "112"→1.5).
    const frac = FRACTION_CODES[tail];
    if (frac !== undefined) {
      const wholePart = digits.length > 2 ? parseInt(digits.slice(0, -2), 10) : 0;
      if (Number.isFinite(wholePart)) return wholePart + frac;
    }

    // Decimal×100 encoding: "50"→0.5, "75"→0.75, "150"→1.5, "250"→2.5, etc.
    // Used by vendors that express trade sizes as hundredths of an inch
    // (e.g. EMT150 = 1.50" = 1-1/2", EMT250 = 2.50" = 2-1/2").
    const dec = DECIMAL_CODES[tail];
    if (dec !== undefined) {
      const wholePart = digits.length > 2 ? parseInt(digits.slice(0, -2), 10) : 0;
      if (Number.isFinite(wholePart)) {
        const val = wholePart + dec;
        if (val > 0 && val <= 12) return val;
      }
    }
  }

  const n = parseInt(digits, 10);
  if (!Number.isFinite(n)) return null;

  // Hundreds-padded whole inches: 100=1", 200=2", 300=3", 400=4", 600=6".
  if (digits.length === 3 && n % 100 === 0 && n >= 100 && n <= 600) {
    return n / 100;
  }
  // Plain bare-integer trade size in the realistic conduit range.
  if (digits.length <= 2 && n >= 1 && n <= 12) return n;

  return null;
}

// Catalog/description tokens that flag an item as conduit, pipe, or one of
// the conduit-family fittings where trailing digits reliably encode a trade
// size. Restricting the size sort to these items prevents accidental
// reordering of unrelated SKUs whose catalog happens to end in digits.
const CONDUIT_TOKENS = [
  // Conduit type abbreviations
  'IMC',
  'EMT',
  'RMC',
  'GRC',
  'RGS',
  'PVC',
  'ENT',
  'FMC',
  'LFMC',
  'LFNC',
  'RNC',
  // Generic conduit/pipe terms
  'CONDUIT',
  'PIPE',
  // Fittings and accessories — each has a trade size encoded in the catalog
  'NIPPLE',
  'COUPLING',
  'ELBOW',
  'SWEEP',
  'OFFSET',
  'FITTING',
  'CONNECTOR',
  'STRAP',
  'CLAMP',
  'HANGER',
  'LOCKNUT',
  'BUSHING',
  'REDUCER',
];

/**
 * True when any of the supplied text fragments look like they describe a
 * conduit, pipe, or conduit-family fitting. Used as a guard around
 * `parseTradeSizeInches` so non-conduit catalog codes that happen to end
 * in digits aren't accidentally reordered.
 */
export function isConduitOrPipe(...texts: (string | null | undefined)[]): boolean {
  const blob = texts.filter(Boolean).join(' ').toUpperCase();
  return CONDUIT_TOKENS.some((t) => blob.includes(t));
}

// Inverse lookup of FRACTION_CODES so we can render a numeric inches value
// back as the human fraction string workers recognize on the shelf. Built
// from the same map as the parser so the two stay in lockstep if codes
// are ever added or changed. Each "12"/"34"/etc. code is split into its
// numerator/denominator for display ("12" → "1/2", "34" → "3/4").
const INCHES_TO_FRACTION: [number, string][] = Object.entries(FRACTION_CODES)
  .map(([code, value]) => {
    const num = code.slice(0, code.length - 1);
    const den = code.slice(code.length - 1);
    return [value, `${num}/${den}`] as [number, string];
  })
  .sort((a, b) => a[0] - b[0]);

/**
 * Format a numeric inches value (as returned by `parseTradeSizeInches`)
 * back into the human fraction string electricians use on the shelf:
 *   0.5  → `1/2"`
 *   0.75 → `3/4"`
 *   1    → `1"`
 *   1.25 → `1 1/4"`
 *   2.5  → `2 1/2"`
 * Falls back to a decimal-with-quote string for sizes that don't land on
 * a known fraction (shouldn't happen for parsed values, but keeps the
 * helper total).
 */
export function formatInchesAsFraction(inches: number | null | undefined): string {
  if (inches == null || !Number.isFinite(inches) || inches <= 0) return '';
  const whole = Math.floor(inches);
  const frac = inches - whole;
  const EPS = 1e-6;
  let fracStr = '';
  if (frac > EPS) {
    const hit = INCHES_TO_FRACTION.find(([v]) => Math.abs(v - frac) < EPS);
    if (hit) {
      fracStr = hit[1];
    } else {
      // Unrecognized fractional remainder — render the whole value as a
      // trimmed decimal so callers always get something readable.
      return `${inches}"`;
    }
  }
  if (whole > 0 && fracStr) return `${whole} ${fracStr}"`;
  if (whole > 0) return `${whole}"`;
  return `${fracStr}"`;
}

/**
 * Compute the variant's "differentiator suffix" relative to the parent
 * catalog by stripping the longest shared leading alpha prefix. Used as
 * a fallback label for series whose catalog codes don't encode a trade
 * size (e.g. parent `BR120` → variant `BR130` returns `130`). Digits
 * always anchor the suffix start so a parent like `BR120` and variant
 * `BR2120` still produce the trailing distinguishing portion.
 *
 * Returns the trimmed suffix, or an empty string when nothing useful
 * can be extracted (callers should render a placeholder in that case).
 */
export function catalogSuffix(
  variantCatalog: string | null | undefined,
  parentCatalog: string | null | undefined
): string {
  if (!variantCatalog) return '';
  const v = variantCatalog.trim();
  if (!v) return '';
  const p = (parentCatalog ?? '').trim();
  // Find longest shared leading alpha-only prefix (case-insensitive).
  let i = 0;
  const max = Math.min(v.length, p.length);
  while (i < max) {
    const a = v[i];
    const b = p[i];
    if (a.toUpperCase() !== b.toUpperCase()) break;
    if (!/[A-Za-z]/.test(a)) break;
    i += 1;
  }
  return v.slice(i).trim();
}
