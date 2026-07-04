/**
 * Pure search helper functions extracted from the inventory search pipeline.
 * All functions here are side-effect-free and safe to unit-test in isolation.
 */

export function normalizeMeasurement(input: string): string {
  return input
    .toLowerCase()
    .replace(/\bone[-\s]half\b/g, "1/2")
    .replace(/\bthree[-\s]quarter[s]?\b/g, "3/4")
    .replace(/\bone[-\s]quarter\b/g, "1/4")
    .replace(/\btwo[-\s]and[-\s]a[-\s]half\b/g, "2-1/2")
    .replace(/\bone[-\s]and[-\s]a[-\s]half\b/g, "1-1/2")
    .replace(/\bone[-\s]and[-\s]a[-\s]quarter\b/g, "1-1/4")
    .replace(/0\.5\s*["in]/g, "1/2\"")
    .replace(/0\.75\s*["in]/g, "3/4\"")
    .replace(/0\.25\s*["in]/g, "1/4\"")
    .replace(/\binches?\b/g, '"')
    .replace(/\bin\b/g, '"');
}

export function parseCatalogNumber(catalog: string): Array<string> {
  const terms: Array<string> = [];
  const c = catalog.toUpperCase();

  // Breakers: BR120, QO120, CH120, HOM120, THQL1120
  const breaker = c.match(/^(BR|QO|CH|HOM|THQL|MP|SWD|FH|HH|Q1)(\d{1,2})?(\d{2,3})/i);
  if (breaker) {
    const series = breaker[1];
    const poles = breaker[2] ? parseInt(breaker[2]) : null;
    const amps = breaker[3] ? parseInt(breaker[3]) : null;
    terms.push(series, `${series} series`);
    if (poles) terms.push(`${poles}p`, `${poles} pole`, poles === 1 ? "single pole" : poles === 2 ? "double pole two pole" : "three pole");
    if (amps) terms.push(`${amps}a`, `${amps}amp`, `${amps} ampere`, `${amps}A breaker`);
  }

  // Wire/cable: NM-B, MC, THHN, THWN, with gauge patterns
  const wireGauge = c.match(/(\d+)\s*\/\s*(\d+)/);
  if (wireGauge) {
    terms.push(`${wireGauge[1]}/${wireGauge[2]}`, `${wireGauge[1]} ${wireGauge[2]} wire`, `${wireGauge[1]} awg`);
    if (wireGauge[2] === "2") terms.push("2 conductor");
    if (wireGauge[2] === "3") terms.push("3 conductor");
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
    terms.push(`${amps}a`, `${amps}amp`, "receptacle", "outlet");
    if (recep[3]) {
      const colorMap: Record<string, string> = {
        WHI: "white", BK: "black", GRY: "gray", IVY: "ivory", ALM: "almond",
        BRN: "brown", RED: "red", BLU: "blue",
      };
      const color = colorMap[recep[3].toUpperCase()];
      if (color) terms.push(color);
    }
  }

  // Transformer voltage pattern
  const xfmr = c.match(/^V(\d+)M(\d+)/i);
  if (xfmr) {
    terms.push("transformer", `${xfmr[1]}v`, `${xfmr[2]}va`);
  }

  // Conduit size from catalog
  const conduitSize = c.match(/^(\d+)\s*(EMT|IMC|RMC|PVC|ENT)/i);
  if (conduitSize) {
    terms.push(`${conduitSize[1]} inch`, conduitSize[2].toLowerCase(), "conduit");
  }

  return terms.filter(Boolean);
}

export function correctMisspelling(word: string, corrections: Map<string, string>): string {
  return corrections.get(word.toLowerCase()) ?? word;
}

/**
 * Extract a numeric size value used as the secondary sort key after confidence.
 *
 * Returns `null` when no recognized size pattern is present so that callers can
 * sort untyped items to a single defined position (we send them to the end of
 * the list) instead of clumping them at value `0` and interleaving them with
 * real fractional sizes like 1/2 or 3/4.
 */
export function extractSizeValue(item: { catalog: string; description: string }): number | null {
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
  return null;
}

/**
 * Comparator suitable for `Array.prototype.sort`. Items without a recognized
 * size (`extractSizeValue` returns `null`) are sorted to the end of the list
 * so a typed run of sizes is never interrupted by an untyped item.
 */
export function compareBySize(
  a: { catalog: string; description: string },
  b: { catalog: string; description: string },
): number {
  const sa = extractSizeValue(a);
  const sb = extractSizeValue(b);
  if (sa === null && sb === null) return 0;
  if (sa === null) return 1;
  if (sb === null) return -1;
  return sa - sb;
}

export function getSeriesBase(
  vendor: string,
  catalog: string,
  _description: string,
): { key: string; label: string } | null {
  const c = catalog.toUpperCase();
  const v = vendor.toUpperCase();

  if (/^(BR|QO|CH|HOM|THQL|MP|FH|HH|Q1)\d/.test(c)) {
    const base = c.match(/^(BR|QO|CH|HOM|THQL|MP|FH|HH|Q1)(\d{1,2})/)?.[1] ?? c.slice(0, 4);
    return { key: `${v}_${base}`, label: "OTHER AMPERAGES" };
  }
  if (/^(DR|CR|TR|GF|5\d{3}|6\d{3})/.test(c)) {
    const base = c.match(/^(DR|CR|TR|GF|\d{4})/)?.[1] ?? c.slice(0, 4);
    return { key: `${v}_${base}`, label: "OTHER COLORS" };
  }
  // Wire/cable series — only suffix-strip when the catalog is gated by a
  // known wire-prefix pattern so we don't accidentally trim real part numbers
  // off non-wire items.
  if (/^(RX|NM|MC|SE|SER|UF|THHN|THWN)\d/.test(c)) {
    const base = c.replace(/\d{3,}FT.*$/, "").replace(/\d{3,}$/, "");
    return { key: `${v}_${base}`, label: "OTHER LENGTHS" };
  }
  if (/^V\d+M\d+/.test(c)) {
    const base = c.match(/^(V\d+M\d+T)/)?.[1] ?? c.slice(0, 8);
    return { key: `${v}_${base}`, label: "OTHER CAPACITIES" };
  }
  // Conduit "OTHER SIZES" — only collapse when the catalog itself starts
  // with a numeric size followed by a conduit type code (e.g. 2EMT, 1.5PVC).
  // Previously we collapsed any catalog whose description merely mentioned a
  // conduit type, which mangled non-conduit items that happened to reference
  // EMT/PVC/etc. in their description.
  if (/^\d+(?:[./]\d+)?(?:EMT|IMC|RMC|PVC|ENT)\b/i.test(c)) {
    const base = c.replace(/^\d+(?:[./]\d+)?/, "");
    return { key: `${v}_${base}`, label: "OTHER SIZES" };
  }
  return null;
}

export function itemFullText(item: {
  vendor: string;
  catalog: string;
  description: string;
  aiKeywords: Array<string> | null;
  expandedDescription?: string | null;
}): string {
  return `${item.vendor} ${item.catalog} ${item.description} ${item.expandedDescription ?? ""} ${(item.aiKeywords ?? []).join(" ")}`.toLowerCase();
}

/** Token-aware match: every word in the filter value must appear as a whole word in `text`. */
export function tokenMatch(text: string, filterValue: string): boolean {
  const tokens = filterValue.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every(tok => {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "i").test(text);
  });
}

export function matchesChipFilters(
  item: { vendor: string; catalog: string; description: string; aiKeywords: Array<string> | null },
  chipFilters: Array<{ key: string; value: string }>,
): boolean {
  const text = itemFullText(item);
  return chipFilters.every(f => tokenMatch(text, f.value));
}

/**
 * Build the per-token POSIX regex strings used to push chip filters into the
 * SQL `WHERE` clause so the candidate-row LIMIT applies AFTER chip filtering,
 * not before.
 *
 * Each filter value is split into whitespace tokens; every token becomes a
 * regex of the form `(^|[^[:alnum:]_])<escaped>($|[^[:alnum:]_])`. The caller
 * ANDs these together against the lowercased concat of vendor/catalog/
 * description/ai_keywords using the case-insensitive `~*` operator.
 *
 * Why not Postgres `\m` / `\M` word anchors? Those only match at a transition
 * between a word and a non-word character, so a token whose first or last
 * character is non-word (`#14`, `1/2"`, `2-1/2`) can never be matched by
 * `\m...\M` even when surrounded by whitespace in the haystack. Several real
 * chip values (wireGauge `#14`, sizeChip `1/2"`, etc.) hit exactly that case,
 * so we use explicit non-alphanumeric/underscore boundary alternations
 * instead. Mirrors the JS `tokenMatch` semantics: a separator character or
 * the string boundary on each side, regardless of whether the token starts
 * with a letter, digit, or punctuation.
 *
 * Regex metacharacters inside the token are escaped so the value is matched
 * literally.
 */
export function buildChipFilterRegexes(
  filters: Array<{ key: string; value: string }>,
): Array<string> {
  const regexes: Array<string> = [];
  for (const f of filters) {
    const value = f.value.trim().toLowerCase();
    if (!value) continue;
    for (const tok of value.split(/\s+/).filter(Boolean)) {
      const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regexes.push(`(^|[^[:alnum:]_])${escaped}($|[^[:alnum:]_])`);
    }
  }
  return regexes;
}
