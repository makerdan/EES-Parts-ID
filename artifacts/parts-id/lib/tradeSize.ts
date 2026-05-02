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
  "18": 1 / 8,
  "14": 1 / 4,
  "38": 3 / 8,
  "12": 1 / 2,
  "58": 5 / 8,
  "34": 3 / 4,
  "78": 7 / 8,
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
  const digits = m[1];

  // Two-digit fraction with optional leading whole part: e.g. "212" → 2 1/2.
  if (digits.length >= 2) {
    const tail = digits.slice(-2);
    const frac = FRACTION_CODES[tail];
    if (frac !== undefined) {
      const wholePart = digits.length > 2 ? parseInt(digits.slice(0, -2), 10) : 0;
      if (Number.isFinite(wholePart)) return wholePart + frac;
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
// the conduit-family fittings (couplings, elbows, nipples, connectors,
// straps) where trailing digits reliably encode a trade size. Restricting
// the size sort to these items prevents accidental reordering of unrelated
// SKUs whose catalog happens to end in digits.
const CONDUIT_TOKENS = [
  "IMC", "EMT", "RMC", "GRC", "RGS", "PVC", "ENT", "FMC", "LFMC", "LFNC",
  "RNC", "CONDUIT", "PIPE", "NIPPLE", "COUPLING", "ELBOW", "STRAP",
  "CONNECTOR",
];

/**
 * True when any of the supplied text fragments look like they describe a
 * conduit, pipe, or conduit-family fitting. Used as a guard around
 * `parseTradeSizeInches` so non-conduit catalog codes that happen to end
 * in digits aren't accidentally reordered.
 */
export function isConduitOrPipe(...texts: Array<string | null | undefined>): boolean {
  const blob = texts.filter(Boolean).join(" ").toUpperCase();
  return CONDUIT_TOKENS.some(t => blob.includes(t));
}
