/**
 * Pure search helper functions extracted from the inventory search pipeline.
 * All functions here are side-effect-free and safe to unit-test in isolation.
 */

export function normalizeMeasurement(input: string): string {
  return input
    .toLowerCase()
    .replace(/\bone[-\s]half\b/g, '1/2')
    .replace(/\bthree[-\s]quarter[s]?\b/g, '3/4')
    .replace(/\bone[-\s]quarter\b/g, '1/4')
    .replace(/\btwo[-\s]and[-\s]a[-\s]half\b/g, '2-1/2')
    .replace(/\bone[-\s]and[-\s]a[-\s]half\b/g, '1-1/2')
    .replace(/\bone[-\s]and[-\s]a[-\s]quarter\b/g, '1-1/4')
    .replace(/0\.5\s*["in]/g, '1/2"')
    .replace(/0\.75\s*["in]/g, '3/4"')
    .replace(/0\.25\s*["in]/g, '1/4"')
    .replace(/\binches?\b/g, '"')
    .replace(/\bin\b/g, '"');
}

export function parseCatalogNumber(catalog: string): string[] {
  const terms: string[] = [];
  const c = catalog.toUpperCase();

  // Breakers: BR120, QO120, CH120, HOM120, THQL1120
  const breaker = c.match(/^(BR|QO|CH|HOM|THQL|MP|SWD|FH|HH|Q1)(\d{1,2})?(\d{2,3})/i);
  if (breaker) {
    const series = breaker[1];
    const poles = breaker[2] ? parseInt(breaker[2]) : null;
    const amps = breaker[3] ? parseInt(breaker[3]) : null;
    terms.push(series, `${series} series`);
    if (poles)
      terms.push(
        `${poles}p`,
        `${poles} pole`,
        poles === 1 ? 'single pole' : poles === 2 ? 'double pole two pole' : 'three pole'
      );
    if (amps) terms.push(`${amps}a`, `${amps}amp`, `${amps} ampere`, `${amps}A breaker`);
  }

  // Wire/cable: NM-B, MC, THHN, THWN, with gauge patterns
  const wireGauge = c.match(/(\d+)\s*\/\s*(\d+)/);
  if (wireGauge) {
    terms.push(
      `${wireGauge[1]}/${wireGauge[2]}`,
      `${wireGauge[1]} ${wireGauge[2]} wire`,
      `${wireGauge[1]} awg`
    );
    if (wireGauge[2] === '2') terms.push('2 conductor');
    if (wireGauge[2] === '3') terms.push('3 conductor');
  }

  // Wire gauge alone (AWG sizes range from 0000=4/0 up to 750 MCM)
  const awg = c.match(/^(\d+)\s*(AWG|GA)?/);
  if (awg && parseInt(awg[1]) <= 750) {
    terms.push(`${awg[1]} awg`, `${awg[1]} gauge`, `#${awg[1]}`);
  }

  // Aught notation (0, 00, 000, 0000 = 1/0, 2/0, 3/0, 4/0)
  const aught = c.match(/^(0{1,4})$/);
  if (aught) {
    const n = aught[1].length;
    terms.push(`${n}/0`, `${n} aught`, `${n}/0 awg`);
  }

  // Receptacle: DR15, CR20, etc.
  const recep = c.match(/^(DR|CR|TR|GF|WR)(\d{2})(\w{2,5})?/i);
  if (recep) {
    const amps = parseInt(recep[2]);
    terms.push(`${amps}a`, `${amps}amp`, 'receptacle', 'outlet');
    if (recep[3]) {
      const colorMap: Record<string, string> = {
        WHI: 'white',
        BK: 'black',
        GRY: 'gray',
        IVY: 'ivory',
        ALM: 'almond',
        BRN: 'brown',
        RED: 'red',
        BLU: 'blue',
      };
      const color = colorMap[recep[3].toUpperCase()];
      if (color) terms.push(color);
    }
  }

  // Transformer voltage pattern
  const xfmr = c.match(/^V(\d+)M(\d+)/i);
  if (xfmr) {
    terms.push('transformer', `${xfmr[1]}v`, `${xfmr[2]}va`);
  }

  // Conduit size from catalog
  const conduitSize = c.match(/^(\d+)\s*(EMT|IMC|RMC|PVC|ENT)/i);
  if (conduitSize) {
    terms.push(`${conduitSize[1]} inch`, conduitSize[2].toLowerCase(), 'conduit');
  }

  return terms.filter(Boolean);
}

export function correctMisspelling(word: string, corrections: Map<string, string>): string {
  return corrections.get(word.toLowerCase()) ?? word;
}

export function extractSizeValue(item: { catalog: string; description: string }): number {
  const text = `${item.catalog} ${item.description}`.toUpperCase();
  // Amperage
  const amp = text.match(/(\d+)\s*A\b/);
  if (amp) return parseInt(amp[1]);
  // Wire gauge (inverted - thicker wire sorts larger: #14=74, #12=76...)
  const awg = text.match(/(\d+)\s*AWG/);
  if (awg) return 88 - parseInt(awg[1]);
  // Mixed fractions
  const mixed = text.match(/(\d+)-(\d+)\/(\d+)/);
  if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
  // Simple fractions
  const frac = text.match(/(\d+)\/(\d+)/);
  if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
  // Decimal
  const dec = text.match(/(\d+\.\d+)/);
  if (dec) return parseFloat(dec[1]);
  // Length
  const ft = text.match(/(\d+)\s*FT/);
  if (ft) return parseInt(ft[1]);
  // Wattage
  const watt = text.match(/(\d+)\s*W\b/);
  if (watt) return parseInt(watt[1]);
  return 0;
}

export function getSeriesBase(
  vendor: string,
  catalog: string,
  description: string
): { key: string; label: string } | null {
  const c = catalog.toUpperCase();
  const v = vendor.toUpperCase();

  if (/^(BR|QO|CH|HOM|THQL|MP|FH|HH|Q1)\d/.test(c)) {
    const base = c.match(/^(BR|QO|CH|HOM|THQL|MP|FH|HH|Q1)(\d{1,2})/)?.[1] ?? c.slice(0, 4);
    return { key: `${v}_${base}`, label: 'OTHER AMPERAGES' };
  }
  if (/^(DR|CR|TR|GF|5\d{3}|6\d{3})/.test(c)) {
    const base = c.match(/^(DR|CR|TR|GF|\d{4})/)?.[1] ?? c.slice(0, 4);
    return { key: `${v}_${base}`, label: 'OTHER COLORS' };
  }
  if (/^(RX|NM|MC|SE|SER|UF|THHN|THWN)\d/.test(c)) {
    const base = c.replace(/\d{3,}FT.*$/, '').replace(/\d{3,}$/, '');
    return { key: `${v}_${base}`, label: 'OTHER LENGTHS' };
  }
  if (/^V\d+M\d+/.test(c)) {
    const base = c.match(/^(V\d+M\d+T)/)?.[1] ?? c.slice(0, 8);
    return { key: `${v}_${base}`, label: 'OTHER CAPACITIES' };
  }
  if (/EMT|IMC|RMC|PVC|ENT/.test(description.toUpperCase())) {
    const base = catalog.replace(/^\d+/, '');
    return { key: `${v}_${base}`, label: 'OTHER SIZES' };
  }
  return null;
}

export function itemFullText(item: {
  vendor: string;
  catalog: string;
  description: string;
  aiKeywords: string[] | null;
}): string {
  return `${item.vendor} ${item.catalog} ${item.description} ${(item.aiKeywords ?? []).join(' ')}`.toLowerCase();
}

/**
 * Token-aware match: every word in the filter value must appear as a
 * whole token in `text`. Token boundaries treat `/` and `-` as part of
 * the token (in addition to `\w`) so a chip like `1/2"` does NOT match
 * inside `1-1/2"` or `2-1/2"` — historically those slipped through
 * because `-` and `/` aren't `\w`, so the smaller size leaked into
 * larger mixed-number sizes.
 */
export function tokenMatch(text: string, filterValue: string): boolean {
  const tokens = filterValue.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((tok) => {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // For fraction tokens (e.g. "1/2", "3/4") add an extra lookbehind that
    // blocks matching inside the space-form of a mixed number (e.g. "1 1/2").
    // The base guard `(?<![\w/-])` catches the dash form "1-1/2" because `-` is
    // in the class, but space is NOT — so without this extra guard `1/2"` would
    // incorrectly match inside `1 1/2"` (written into aiKeywords by
    // tradeSizeKeywordTokens).
    //
    // `(?<![^\d]\d[ -])` is a 3-char lookbehind: it checks that the THREE
    // chars before the token are NOT non-digit + digit + space/dash.  This
    // pattern fires for a space-form whole number like `1 ` in `1 1/2"` (where
    // ` 1 ` matches [^\d]\d[ -]) but does NOT fire for a multi-digit catalog
    // suffix like `34 ` in `emt34 3/4"` (where `3` IS a digit, so [^\d] fails).
    // A 2-char lookbehind `(?<!\d[ -])` was too broad: it blocked `3/4"` from
    // matching in `emt34 3/4"` because the `4 ` at the end of the catalog
    // number triggered it even though `4` is not a standalone whole number.
    // This 3-char form is intentionally limited to fraction tokens so non-
    // fractional chips like "20A" remain unaffected.
    const pattern = tok.includes('/')
      ? `(?<![\\w/-])(?<![^\\d]\\d[ -])${escaped}(?![\\w/-])`
      : `(?<![\\w/-])${escaped}(?![\\w/-])`;
    return new RegExp(pattern, 'i').test(text);
  });
}

/**
 * Map a `mountingType` chip option (e.g. "Surface", "DIN Rail") to the
 * canonical lowercase value emitted by `parseMountType()` and stored in
 * the `mount_type` column. Returns null when the chip option doesn't
 * have a structured-column counterpart (e.g. "Panel Mount", "Pendant",
 * "Track") — those still go through the text-match fallback.
 */
function chipMountTypeToColumn(chipValue: string): string | null {
  const v = chipValue.trim().toLowerCase();
  if (v === 'surface') return 'surface';
  if (v === 'flush') return 'flush';
  if (v === 'din rail' || v === 'din-rail') return 'din-rail';
  if (v === 'bolt-on') return 'bolt-on';
  if (v === 'plug-in') return 'plug-in';
  return null;
}

/**
 * Item shape used by chip filtering. Includes the structured columns
 * materialized by the v2/v3 parser so chip predicates can short-circuit
 * past the slower free-text path when scalar data is available.
 */
export interface ChipFilterItem {
  vendor: string;
  catalog: string;
  description: string;
  aiKeywords: string[] | null;
  amperage?: number | null;
  poleCount?: number | null;
  voltage?: number | null;
  mountType?: string | null;
}

/**
 * Try to evaluate a single chip filter against the item's structured
 * columns. Returns:
 *   - true  → column is populated AND matches the chip value
 *   - false → column is populated AND does NOT match (definitive miss)
 *   - null  → no structured-column path applies for this chip key, or
 *             the column is NULL (caller should fall back to text match)
 *
 * Filters wired to scalar columns (with their respective indexes from
 * migration 0010 + composite indexes from migration 0016):
 *   amperage     → inventory.amperage      (idx_inventory_amperage)
 *   poleCount    → inventory.pole_count    (idx_inventory_pole_count)
 *   voltage      → inventory.voltage       (idx_inventory_voltage)
 *   mountingType → inventory.mount_type    (idx_inventory_mount_type)
 *
 * The fallback is critical: ~95% of rows still have catalog_parse=NULL,
 * but their amperage/voltage are often populated from description-based
 * regex (parseAmperage/parseVoltage in parseAttributes.ts). When a column
 * is genuinely NULL we return null so the caller can text-match instead
 * of silently dropping the row.
 */
export function matchesChipColumn(
  item: ChipFilterItem,
  key: string,
  value: string
): boolean | null {
  if (key === 'amperage') {
    if (item.amperage == null) return null;
    const n = parseInt(value.replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(n)) return null;
    return item.amperage === n;
  }
  if (key === 'poleCount') {
    if (item.poleCount == null) return null;
    const m = value.match(/(\d+)/);
    if (!m) return null;
    return item.poleCount === parseInt(m[1]!, 10);
  }
  if (key === 'voltage') {
    if (item.voltage == null) return null;
    const n = parseInt(value.replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(n)) return null;
    return item.voltage === n;
  }
  if (key === 'mountingType') {
    const mapped = chipMountTypeToColumn(value);
    if (mapped == null) return null; // chip option has no column counterpart
    if (item.mountType == null) return null;
    return item.mountType.toLowerCase() === mapped;
  }
  return null;
}

export function matchesChipFilters(
  item: ChipFilterItem,
  chipFilters: Array<{ key: string; value: string }>
): boolean {
  const text = itemFullText(item);
  return chipFilters.every((f) => {
    // Try the structured-column path first for amperage/poleCount/voltage/
    // mountingType. A definitive true/false short-circuits the text match;
    // a null result (no column data) falls back to the original token match
    // against vendor/catalog/description/aiKeywords — preserving today's
    // behavior for the ~95% of rows whose catalog_parse is still NULL.
    const colResult = matchesChipColumn(item, f.key, f.value);
    if (colResult !== null) return colResult;
    return tokenMatch(text, f.value);
  });
}
