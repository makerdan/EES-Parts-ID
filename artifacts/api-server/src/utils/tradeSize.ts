/**
 * Server-side trade-size helpers. Parses the diameter encoded in the
 * trailing digits of a conduit/pipe catalog code (warehouse convention,
 * e.g. IMC212 → 2 1/2") and turns the result into the keyword tokens that
 * power the "Trade Size" filter chip and free-text search.
 *
 * Mirrors artifacts/parts-id/lib/tradeSize.ts so the same parsing rule is
 * applied client-side (default sort) and server-side (DB enrichment +
 * search). Kept as a separate file (no DB / Express imports) so it can be
 * unit tested in isolation.
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

/** Trade size in inches, or null when no recognizable size is present. */
export function parseTradeSizeInches(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.toUpperCase().match(/(\d+)\s*$/);
  if (!m) return null;
  const digits = m[1];

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

  if (digits.length === 3 && n % 100 === 0 && n >= 100 && n <= 600) return n / 100;
  if (digits.length <= 2 && n >= 1 && n <= 12) return n;

  return null;
}

const CONDUIT_TOKENS = [
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
  'CONDUIT',
  'PIPE',
  'NIPPLE',
  'COUPLING',
  'ELBOW',
  'STRAP',
  'CONNECTOR',
  'FITTING',   // conduit bodies, cord/cable fittings, PVC fittings, etc.
  'BUSHING',   // ground bushing, reducing bushing, insulating bushing
  'LOCKNUT',   // conduit locknut
  'KNOCKOUT',  // conduit knockout plug
];

/** True when any text fragment looks like a conduit, pipe, or fitting. */
export function isConduitOrPipe(...texts: Array<string | null | undefined>): boolean {
  const blob = texts.filter(Boolean).join(' ').toUpperCase();
  return CONDUIT_TOKENS.some((t) => blob.includes(t));
}

/**
 * Map an inch value to the canonical chip-option label used by
 * `FilterPanel`'s Trade Size chip. Returns null for sizes that aren't on
 * the chip list (so we never invent display strings the chip can't match).
 *
 * The chip uses dash-joined mixed numbers (`1-1/4"`) instead of the more
 * common `1 1/4"` to keep each option a single whitespace-free token —
 * `tokenMatch` would otherwise split on the space and require BOTH halves
 * to appear adjacently in item text, which a token-aware match can't do.
 */
export function tradeSizeChipLabel(inches: number): string | null {
  const map: Record<string, string> = {
    '0.125': '1/8"',
    '0.25': '1/4"',
    '0.375': '3/8"',
    '0.5': '1/2"',
    '0.625': '5/8"',
    '0.75': '3/4"',
    '0.875': '7/8"',
    '1': '1"',
    '1.25': '1-1/4"',
    '1.5': '1-1/2"',
    '1.75': '1-3/4"',
    '2': '2"',
    '2.5': '2-1/2"',
    '3': '3"',
    '3.5': '3-1/2"',
    '4': '4"',
    '5': '5"',
    '6': '6"',
  };
  // Round to 1/8" precision so floating-point noise doesn't miss the map.
  const rounded = Math.round(inches * 8) / 8;
  return map[String(rounded)] ?? null;
}

/**
 * All keyword variants worth indexing for a parsed trade size. The first
 * entry always matches the chip label exactly so the Trade Size filter
 * works; the rest are natural-language phrasings users might type into
 * free-text search ("1/2 inch", "1/2in.", "0.5 inches", etc.).
 */
export function tradeSizeKeywordTokens(inches: number): string[] {
  const chip = tradeSizeChipLabel(inches);
  if (!chip) return [];
  const tokens = new Set<string>([chip]);

  // Strip the trailing inch mark for the bare fraction/mixed-number form.
  const bare = chip.replace(/"$/, '');

  // Collect every "display form" of the number that users might type.
  const forms: string[] = [bare];

  // "1 1/4" form (space instead of dash) for mixed numbers.
  if (bare.includes('-')) {
    forms.push(bare.replace('-', ' '));
  }

  // Decimal form (e.g. 1.25, 0.5) for vendor descriptions that use decimals.
  forms.push(inches.toString());

  // For each display form emit every suffix variant a worker might type.
  const suffixes = [
    '', // bare number alone
    '"', // with inch mark  (e.g. 0.5")
    'in.', // e.g. 1/2in.
    ' in.', // e.g. 1/2 in.
    'in', // e.g. 1/2in
    ' in', // e.g. 1/2 in
    'inch', // e.g. 1/2inch
    ' inch', // e.g. 1/2 inch
    'inches', // e.g. 1/2inches
    ' inches', // e.g. 1/2 inches
  ];

  for (const form of forms) {
    for (const suffix of suffixes) {
      tokens.add(`${form}${suffix}`);
    }
  }

  return [...tokens];
}

/**
 * Convenience: derive the trade-size keyword tokens for a catalog item,
 * returning [] when the item isn't recognized as conduit/pipe or has no
 * parseable size. Used by the backfill script and the insert hooks so
 * the same logic applies everywhere.
 */
export function deriveTradeSizeTokens(item: {
  vendor?: string | null;
  catalog?: string | null;
  description?: string | null;
}): string[] {
  if (!isConduitOrPipe(item.catalog, item.vendor, item.description)) return [];
  const inches = parseTradeSizeInches(item.catalog) ?? parseTradeSizeInches(item.description);
  if (inches === null) return [];
  return tradeSizeKeywordTokens(inches);
}
