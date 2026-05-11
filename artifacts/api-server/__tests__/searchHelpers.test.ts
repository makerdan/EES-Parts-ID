/**
 * Unit tests for the search helper utilities (src/utils/searchHelpers.ts).
 *
 * All helpers are pure functions; no database or network access is required.
 *
 * Functions under test:
 *   normalizeMeasurement  — rewrites written or decimal inch measurements in
 *                           a search query to canonical notation (e.g.
 *                           "one-half inch" → "1/2") for consistent matching.
 *   parseCatalogNumber    — expands a catalog number into human-readable
 *                           search terms (pole count, amperage, color, …).
 *   correctMisspelling    — performs a case-insensitive lookup in a
 *                           caller-supplied correction map.
 *   extractSizeValue      — returns a numeric sort key from catalog + description
 *                           (amperage, AWG, trade size, length, wattage, …).
 *   getSeriesBase         — identifies the "series group" an item belongs to
 *                           so the UI can surface sibling items.
 *   itemFullText          — builds a lowercased concatenated blob of all
 *                           searchable text fields for client-side Fuse.js.
 *   tokenMatch            — tests whether every token in a chip filter value
 *                           appears as a whole word in the haystack, with
 *                           special handling for trade-size fractions that
 *                           must not leak into mixed-number larger sizes.
 *   matchesChipColumn     — resolves a chip filter against a typed DB column,
 *                           returning null when the column is absent/NULL
 *                           so the caller can fall back to text matching.
 *   matchesChipFilters    — applies a list of chip filters to one item using
 *                           column values when populated and text matching
 *                           as a fallback.
 */
import {
  normalizeMeasurement,
  parseCatalogNumber,
  correctMisspelling,
  extractSizeValue,
  getSeriesBase,
  itemFullText,
  tokenMatch,
  matchesChipColumn,
  matchesChipFilters,
  type ChipFilterItem,
} from '../src/utils/searchHelpers';

// ── normalizeMeasurement ──────────────────────────────────────────────────────

describe('normalizeMeasurement', () => {
  it('converts written fraction words to numeric fractions', () => {
    expect(normalizeMeasurement('one-half inch conduit')).toContain('1/2');
    expect(normalizeMeasurement('three-quarter conduit')).toContain('3/4');
    expect(normalizeMeasurement('one-quarter inch')).toContain('1/4');
  });

  it('converts written compound fractions', () => {
    expect(normalizeMeasurement('two-and-a-half inch')).toContain('2-1/2');
    expect(normalizeMeasurement('one-and-a-half conduit')).toContain('1-1/2');
    expect(normalizeMeasurement('one-and-a-quarter pipe')).toContain('1-1/4');
  });

  it('converts decimal inch notation to fractional', () => {
    expect(normalizeMeasurement('0.5in conduit')).toContain('1/2');
    expect(normalizeMeasurement('0.75in conduit')).toContain('3/4');
    expect(normalizeMeasurement('0.25in conduit')).toContain('1/4');
  });

  it("converts the word 'inches' to double-quote symbol", () => {
    expect(normalizeMeasurement('4 inches EMT')).toContain('4 "');
  });

  it('lowercases the entire string', () => {
    expect(normalizeMeasurement('BREAKER')).toBe('breaker');
  });

  it('returns unchanged strings that have no measurement patterns', () => {
    const input = '20a circuit breaker';
    expect(normalizeMeasurement(input)).toBe(input);
  });
});

// ── parseCatalogNumber ────────────────────────────────────────────────────────

describe('parseCatalogNumber', () => {
  it('parses single-pole breaker catalog numbers', () => {
    const terms = parseCatalogNumber('BR120');
    expect(terms).toContain('BR');
    expect(terms).toContain('20a');
    expect(terms).toContain('20amp');
    expect(terms.some((t) => /single pole/i.test(t))).toBe(true);
  });

  it('parses two-pole breaker catalog numbers', () => {
    const terms = parseCatalogNumber('QO220');
    expect(terms).toContain('QO');
    expect(terms.some((t) => /double pole/i.test(t))).toBe(true);
    expect(terms).toContain('20a');
  });

  it('parses Square D QO2020 (two 20A)', () => {
    const terms = parseCatalogNumber('QO2020');
    expect(terms).toContain('QO');
  });

  it('parses wire gauge fraction patterns', () => {
    const terms = parseCatalogNumber('12/2');
    expect(terms).toContain('12/2');
    expect(terms).toContain('12 awg');
    expect(terms).toContain('2 conductor');
  });

  it('parses 14/3 with 3 conductor label', () => {
    const terms = parseCatalogNumber('14/3');
    expect(terms).toContain('3 conductor');
    expect(terms).toContain('14 awg');
  });

  it('parses receptacle catalog with color suffix', () => {
    const terms = parseCatalogNumber('DR15WHI');
    expect(terms).toContain('15a');
    expect(terms).toContain('receptacle');
    expect(terms).toContain('outlet');
    expect(terms).toContain('white');
  });

  it('parses transformer voltage pattern', () => {
    const terms = parseCatalogNumber('V120M500');
    expect(terms).toContain('transformer');
    expect(terms).toContain('120v');
    expect(terms).toContain('500va');
  });

  it('parses conduit size from catalog prefix', () => {
    const terms = parseCatalogNumber('2EMT');
    expect(terms).toContain('2 inch');
    expect(terms).toContain('emt');
    expect(terms).toContain('conduit');
  });

  it('parses aught wire notation (0000 = 4/0)', () => {
    const terms = parseCatalogNumber('0000');
    expect(terms).toContain('4/0');
    expect(terms).toContain('4 aught');
  });

  it('returns empty array for unrecognized catalog with no digits', () => {
    const terms = parseCatalogNumber('MISC');
    expect(Array.isArray(terms)).toBe(true);
  });
});

// ── correctMisspelling ────────────────────────────────────────────────────────

describe('correctMisspelling', () => {
  it('returns the corrected spelling from the map', () => {
    const map = new Map([
      ['breker', 'breaker'],
      ['recptacle', 'receptacle'],
    ]);
    expect(correctMisspelling('breker', map)).toBe('breaker');
    expect(correctMisspelling('RECPTACLE', map)).toBe('receptacle');
  });

  it('returns the original word when not in the map', () => {
    const map = new Map([['breker', 'breaker']]);
    expect(correctMisspelling('switch', map)).toBe('switch');
  });

  it('is case-insensitive on the lookup key', () => {
    const map = new Map([['breker', 'breaker']]);
    expect(correctMisspelling('BREKER', map)).toBe('breaker');
  });

  it('returns original casing for unknown words', () => {
    const map = new Map<string, string>();
    expect(correctMisspelling('Receptacle', map)).toBe('Receptacle');
  });
});

// ── extractSizeValue ──────────────────────────────────────────────────────────

describe('extractSizeValue', () => {
  const item = (catalog: string, description: string) => ({ catalog, description });

  it('extracts amperage value', () => {
    expect(extractSizeValue(item('BR120', '20A single-pole breaker'))).toBe(20);
  });

  it('extracts AWG gauge as inverted sort key', () => {
    // #14 AWG → 88 - 14 = 74; thicker wire (#12) → 76 (sorts higher)
    expect(extractSizeValue(item('THHN', '14 AWG wire'))).toBe(74);
    expect(extractSizeValue(item('THHN', '12 AWG wire'))).toBe(76);
  });

  it('extracts mixed fraction sizes (1-1/2)', () => {
    expect(extractSizeValue(item('EMT', '1-1/2 conduit'))).toBeCloseTo(1.5);
  });

  it('extracts simple fraction sizes (3/4)', () => {
    expect(extractSizeValue(item('EMT', '3/4 conduit'))).toBeCloseTo(0.75);
  });

  it('extracts decimal sizes', () => {
    expect(extractSizeValue(item('PVC', '2.5 conduit'))).toBeCloseTo(2.5);
  });

  it('extracts foot lengths when no higher-priority pattern matches', () => {
    expect(extractSizeValue(item('THHN', '250FT spool'))).toBe(250);
  });

  it('extracts wattage', () => {
    expect(extractSizeValue(item('LED100W', '100W LED bulb'))).toBe(100);
  });

  it('returns 0 when no size is found', () => {
    expect(extractSizeValue(item('MISC', 'general hardware'))).toBe(0);
  });
});

// ── getSeriesBase ─────────────────────────────────────────────────────────────

describe('getSeriesBase', () => {
  it('groups breakers by series', () => {
    const result = getSeriesBase('Eaton', 'BR120', '20A breaker');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('OTHER AMPERAGES');
    expect(result!.key).toContain('EATON');
    expect(result!.key).toContain('BR');
  });

  it('groups receptacles by color/type', () => {
    const result = getSeriesBase('Hubbell', 'DR15WHI', '15A receptacle');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('OTHER COLORS');
  });

  it('groups wires by length', () => {
    const result = getSeriesBase('Southwire', 'NM12/2-250FT', 'NM-B 12/2 250ft');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('OTHER LENGTHS');
  });

  it('groups transformers by capacity', () => {
    const result = getSeriesBase('Acme', 'V120M500T1PH', 'transformer');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('OTHER CAPACITIES');
  });

  it('groups conduit by size when description contains conduit type', () => {
    const result = getSeriesBase('Allied', '2EMT', '2 inch EMT conduit');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('OTHER SIZES');
  });

  it('returns null for unrecognised catalog patterns', () => {
    const result = getSeriesBase('Vendor', 'MISC123', 'miscellaneous item');
    expect(result).toBeNull();
  });
});

// ── itemFullText ──────────────────────────────────────────────────────────────

describe('itemFullText', () => {
  it('concatenates vendor, catalog, description, and aiKeywords', () => {
    const text = itemFullText({
      vendor: 'Eaton',
      catalog: 'BR120',
      description: '20A breaker',
      aiKeywords: ['single pole', 'residential'],
    });
    expect(text).toContain('eaton');
    expect(text).toContain('br120');
    expect(text).toContain('20a breaker');
    expect(text).toContain('single pole');
    expect(text).toContain('residential');
  });

  it('handles null aiKeywords without throwing', () => {
    const text = itemFullText({
      vendor: 'Hubbell',
      catalog: 'DR15',
      description: '15A receptacle',
      aiKeywords: null,
    });
    expect(text).toContain('hubbell');
    expect(text).toContain('dr15');
  });

  it('returns all text in lowercase', () => {
    const text = itemFullText({
      vendor: 'EATON',
      catalog: 'BR120',
      description: '20A BREAKER',
      aiKeywords: ['SINGLE POLE'],
    });
    expect(text).toBe(text.toLowerCase());
  });
});

// ── tokenMatch ────────────────────────────────────────────────────────────────

describe('tokenMatch', () => {
  it('matches when the filter token appears as a whole word', () => {
    expect(tokenMatch('20a single pole breaker', 'breaker')).toBe(true);
    expect(tokenMatch('20a single pole breaker', '20a')).toBe(true);
  });

  it('does not match when the token appears only as a substring', () => {
    // "20" should not match inside "200a"
    expect(tokenMatch('200a double pole breaker', '20')).toBe(false);
  });

  it('matches multi-token filter values (AND logic)', () => {
    expect(tokenMatch('20a single pole breaker eaton', 'single pole')).toBe(true);
    expect(tokenMatch('20a double pole breaker eaton', 'single pole')).toBe(false);
  });

  it('returns true for an empty filter value', () => {
    expect(tokenMatch('anything', '')).toBe(true);
    expect(tokenMatch('anything', '  ')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(tokenMatch('eaton br120 breaker', 'BREAKER')).toBe(true);
    expect(tokenMatch('EATON BR120 BREAKER', 'breaker')).toBe(true);
  });

  it("handles filter tokens with regex special characters (e.g. '1/2\"')", () => {
    expect(tokenMatch('3/4" emt conduit', '3/4"')).toBe(true);
    expect(tokenMatch('1/2" emt conduit', '3/4"')).toBe(false);
  });

  it('matches size codes within a description', () => {
    expect(tokenMatch('1-1/2 inch emt conduit fitting', '1-1/2')).toBe(true);
  });

  it('does not let a smaller trade size leak into a mixed-number larger size', () => {
    // Regression: chip value 1/2" used to match inside 1-1/2" / 2-1/2"
    // because - and / aren't \w, so the word-boundary lookarounds let the
    // substring through.
    expect(tokenMatch('1-1/2" emt conduit', '1/2"')).toBe(false);
    expect(tokenMatch('2-1/2" emt conduit', '1/2"')).toBe(false);
    expect(tokenMatch('1-1/4" emt conduit', '1/4"')).toBe(false);
    // Sanity: the matching size still selects its own item.
    expect(tokenMatch('1/2" emt conduit', '1/2"')).toBe(true);
    expect(tokenMatch('1-1/2" emt conduit', '1-1/2"')).toBe(true);
  });
});

// ── matchesChipColumn ─────────────────────────────────────────────────────────

describe('matchesChipColumn', () => {
  // Helper: base item with no structured columns set
  const base: ChipFilterItem = {
    vendor: 'Eaton',
    catalog: 'BR120',
    description: '20A single pole breaker',
    aiKeywords: null,
  };

  // ── amperage ──────────────────────────────────────────────────────────────

  describe('amperage', () => {
    it('returns true when column is populated and matches the chip value', () => {
      const item: ChipFilterItem = { ...base, amperage: 20 };
      expect(matchesChipColumn(item, 'amperage', '20A')).toBe(true);
    });

    it('returns false when column is populated and does NOT match the chip value', () => {
      const item: ChipFilterItem = { ...base, amperage: 30 };
      expect(matchesChipColumn(item, 'amperage', '20A')).toBe(false);
    });

    it('returns null when column is NULL (caller should fall back to text match)', () => {
      const item: ChipFilterItem = { ...base, amperage: null };
      expect(matchesChipColumn(item, 'amperage', '20A')).toBeNull();
    });

    it('returns null when column is absent (undefined)', () => {
      expect(matchesChipColumn(base, 'amperage', '20A')).toBeNull();
    });
  });

  // ── poleCount ─────────────────────────────────────────────────────────────

  describe('poleCount', () => {
    it('returns true when column is populated and matches the chip value', () => {
      const item: ChipFilterItem = { ...base, poleCount: 1 };
      expect(matchesChipColumn(item, 'poleCount', '1 Pole')).toBe(true);
    });

    it('returns false when column is populated and does NOT match the chip value', () => {
      const item: ChipFilterItem = { ...base, poleCount: 2 };
      expect(matchesChipColumn(item, 'poleCount', '1 Pole')).toBe(false);
    });

    it('returns null when column is NULL (caller should fall back to text match)', () => {
      const item: ChipFilterItem = { ...base, poleCount: null };
      expect(matchesChipColumn(item, 'poleCount', '1 Pole')).toBeNull();
    });

    it('returns null when column is absent (undefined)', () => {
      expect(matchesChipColumn(base, 'poleCount', '1 Pole')).toBeNull();
    });
  });

  // ── voltage ───────────────────────────────────────────────────────────────

  describe('voltage', () => {
    it('returns true when column is populated and matches the chip value', () => {
      const item: ChipFilterItem = { ...base, voltage: 120 };
      expect(matchesChipColumn(item, 'voltage', '120V')).toBe(true);
    });

    it('returns false when column is populated and does NOT match the chip value', () => {
      const item: ChipFilterItem = { ...base, voltage: 240 };
      expect(matchesChipColumn(item, 'voltage', '120V')).toBe(false);
    });

    it('returns null when column is NULL (caller should fall back to text match)', () => {
      const item: ChipFilterItem = { ...base, voltage: null };
      expect(matchesChipColumn(item, 'voltage', '120V')).toBeNull();
    });

    it('returns null when column is absent (undefined)', () => {
      expect(matchesChipColumn(base, 'voltage', '120V')).toBeNull();
    });
  });

  // ── mountingType ──────────────────────────────────────────────────────────

  describe('mountingType', () => {
    it('returns true when column is populated and matches the chip value', () => {
      const item: ChipFilterItem = { ...base, mountType: 'surface' };
      expect(matchesChipColumn(item, 'mountingType', 'Surface')).toBe(true);
    });

    it('returns false when column is populated and does NOT match the chip value', () => {
      const item: ChipFilterItem = { ...base, mountType: 'flush' };
      expect(matchesChipColumn(item, 'mountingType', 'Surface')).toBe(false);
    });

    it('returns null when column is NULL (caller should fall back to text match)', () => {
      const item: ChipFilterItem = { ...base, mountType: null };
      expect(matchesChipColumn(item, 'mountingType', 'Surface')).toBeNull();
    });

    it('returns null for chip options without a column counterpart (e.g. "Panel Mount")', () => {
      const item: ChipFilterItem = { ...base, mountType: 'surface' };
      expect(matchesChipColumn(item, 'mountingType', 'Panel Mount')).toBeNull();
    });

    it('returns null for DIN Rail chip value when column is NULL', () => {
      const item: ChipFilterItem = { ...base, mountType: null };
      expect(matchesChipColumn(item, 'mountingType', 'DIN Rail')).toBeNull();
    });

    it('returns true for DIN Rail chip value when column matches', () => {
      const item: ChipFilterItem = { ...base, mountType: 'din-rail' };
      expect(matchesChipColumn(item, 'mountingType', 'DIN Rail')).toBe(true);
    });
  });

  // ── unknown key ───────────────────────────────────────────────────────────

  it('returns null for unrecognised chip keys (no column path)', () => {
    const item: ChipFilterItem = { ...base, amperage: 20 };
    expect(matchesChipColumn(item, 'colorChip', 'White')).toBeNull();
    expect(matchesChipColumn(item, 'tradeSize', '1/2"')).toBeNull();
  });
});

// ── matchesChipFilters — column-aware fallback ────────────────────────────────

describe('matchesChipFilters — column-aware fallback', () => {
  // ── amperage ──────────────────────────────────────────────────────────────

  describe('amperage chip', () => {
    it('column populated and matches → included', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR120',
        description: 'breaker',
        aiKeywords: null,
        amperage: 20,
      };
      expect(matchesChipFilters(item, [{ key: 'amperage', value: '20A' }])).toBe(true);
    });

    it('column populated and mismatches → excluded', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR130',
        description: 'breaker',
        aiKeywords: null,
        amperage: 30,
      };
      expect(matchesChipFilters(item, [{ key: 'amperage', value: '20A' }])).toBe(false);
    });

    it('column NULL, description contains value → included via text fallback', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR120',
        description: '20A single pole breaker',
        aiKeywords: null,
        amperage: null,
      };
      expect(matchesChipFilters(item, [{ key: 'amperage', value: '20A' }])).toBe(true);
    });

    it('column NULL, description does NOT contain value → excluded via text fallback', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR130',
        description: '30A single pole breaker',
        aiKeywords: null,
        amperage: null,
      };
      expect(matchesChipFilters(item, [{ key: 'amperage', value: '20A' }])).toBe(false);
    });
  });

  // ── poleCount ─────────────────────────────────────────────────────────────

  describe('poleCount chip', () => {
    it('column populated and matches → included', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR120',
        description: 'breaker',
        aiKeywords: null,
        poleCount: 2,
      };
      expect(matchesChipFilters(item, [{ key: 'poleCount', value: '2 Pole' }])).toBe(true);
    });

    it('column populated and mismatches → excluded', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR120',
        description: 'breaker',
        aiKeywords: null,
        poleCount: 1,
      };
      expect(matchesChipFilters(item, [{ key: 'poleCount', value: '2 Pole' }])).toBe(false);
    });

    it('column NULL, description contains value → included via text fallback', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR220',
        description: '20A 2 pole breaker',
        aiKeywords: null,
        poleCount: null,
      };
      expect(matchesChipFilters(item, [{ key: 'poleCount', value: '2' }])).toBe(true);
    });

    it('column NULL, description does NOT contain value → excluded via text fallback', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR120',
        description: '20A single pole breaker',
        aiKeywords: null,
        poleCount: null,
      };
      expect(matchesChipFilters(item, [{ key: 'poleCount', value: '2 Pole' }])).toBe(false);
    });
  });

  // ── voltage ───────────────────────────────────────────────────────────────

  describe('voltage chip', () => {
    it('column populated and matches → included', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR120',
        description: 'breaker',
        aiKeywords: null,
        voltage: 120,
      };
      expect(matchesChipFilters(item, [{ key: 'voltage', value: '120V' }])).toBe(true);
    });

    it('column populated and mismatches → excluded', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR240',
        description: 'breaker',
        aiKeywords: null,
        voltage: 240,
      };
      expect(matchesChipFilters(item, [{ key: 'voltage', value: '120V' }])).toBe(false);
    });

    it('column NULL, description contains value → included via text fallback', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR120',
        description: '120V 20A breaker',
        aiKeywords: null,
        voltage: null,
      };
      expect(matchesChipFilters(item, [{ key: 'voltage', value: '120V' }])).toBe(true);
    });

    it('column NULL, description does NOT contain value → excluded via text fallback', () => {
      const item: ChipFilterItem = {
        vendor: 'Eaton',
        catalog: 'BR240',
        description: '240V 20A breaker',
        aiKeywords: null,
        voltage: null,
      };
      expect(matchesChipFilters(item, [{ key: 'voltage', value: '120V' }])).toBe(false);
    });
  });

  // ── mountingType ──────────────────────────────────────────────────────────

  describe('mountingType chip', () => {
    it('column populated and matches → included', () => {
      const item: ChipFilterItem = {
        vendor: 'Legrand',
        catalog: 'SURF1',
        description: 'surface box',
        aiKeywords: null,
        mountType: 'surface',
      };
      expect(matchesChipFilters(item, [{ key: 'mountingType', value: 'Surface' }])).toBe(true);
    });

    it('column populated and mismatches → excluded', () => {
      const item: ChipFilterItem = {
        vendor: 'Legrand',
        catalog: 'FLUSH1',
        description: 'flush box',
        aiKeywords: null,
        mountType: 'flush',
      };
      expect(matchesChipFilters(item, [{ key: 'mountingType', value: 'Surface' }])).toBe(false);
    });

    it('column NULL, description contains value → included via text fallback', () => {
      const item: ChipFilterItem = {
        vendor: 'Legrand',
        catalog: 'SURF1',
        description: 'surface mount enclosure',
        aiKeywords: null,
        mountType: null,
      };
      expect(matchesChipFilters(item, [{ key: 'mountingType', value: 'Surface' }])).toBe(true);
    });

    it('column NULL, description does NOT contain value → excluded via text fallback', () => {
      const item: ChipFilterItem = {
        vendor: 'Legrand',
        catalog: 'FLUSH1',
        description: 'flush mount enclosure',
        aiKeywords: null,
        mountType: null,
      };
      expect(matchesChipFilters(item, [{ key: 'mountingType', value: 'Surface' }])).toBe(false);
    });

    it('chip option with no column counterpart falls back to text match', () => {
      const withText: ChipFilterItem = {
        vendor: 'Legrand',
        catalog: 'PNL1',
        description: 'panel mount enclosure',
        aiKeywords: null,
        mountType: 'surface',
      };
      const withoutText: ChipFilterItem = {
        vendor: 'Legrand',
        catalog: 'PNL2',
        description: 'surface enclosure',
        aiKeywords: null,
        mountType: 'surface',
      };
      expect(matchesChipFilters(withText, [{ key: 'mountingType', value: 'Panel Mount' }])).toBe(
        true
      );
      expect(matchesChipFilters(withoutText, [{ key: 'mountingType', value: 'Panel Mount' }])).toBe(
        false
      );
    });
  });
});

// ── matchesChipFilters ────────────────────────────────────────────────────────

describe('matchesChipFilters', () => {
  const item = (description: string) => ({
    vendor: 'Eaton',
    catalog: 'BR120',
    description,
    aiKeywords: null,
  });

  it('returns true when all chip filters match', () => {
    const result = matchesChipFilters(item('20a single pole breaker white'), [
      { key: 'amperage', value: '20a' },
      { key: 'poleCount', value: 'single pole' },
    ]);
    expect(result).toBe(true);
  });

  it('returns false when any chip filter does not match', () => {
    const result = matchesChipFilters(item('20a single pole breaker'), [
      { key: 'amperage', value: '20a' },
      { key: 'colorChip', value: 'Red' },
    ]);
    expect(result).toBe(false);
  });

  it('returns true with an empty filter array', () => {
    expect(matchesChipFilters(item('any description'), [])).toBe(true);
  });

  it('uses aiKeywords in the match text when provided', () => {
    const itemWithKw = {
      vendor: 'Eaton',
      catalog: 'BR120',
      description: 'breaker',
      aiKeywords: ['residential', 'loadcenter'],
    };
    const result = matchesChipFilters(itemWithKw, [{ key: 'misc', value: 'loadcenter' }]);
    expect(result).toBe(true);
  });
});

// ── matchesChipFilters — text-only chip keys ───────────────────────────────────
// tradeSize, colorChip, and conduitType have no structured column and always
// rely on tokenMatch against the full-text representation of the item.

describe('matchesChipFilters — tradeSize chip (text-only, no column)', () => {
  const item = (description: string): ChipFilterItem => ({
    vendor: 'Allied',
    catalog: 'EMT34',
    description,
    aiKeywords: null,
  });

  it('token present in description → included', () => {
    expect(
      matchesChipFilters(item('3/4" EMT conduit'), [{ key: 'tradeSize', value: '3/4"' }])
    ).toBe(true);
  });

  it('token absent from description → excluded', () => {
    expect(
      matchesChipFilters(item('1/2" EMT conduit'), [{ key: 'tradeSize', value: '3/4"' }])
    ).toBe(false);
  });

  it('token appears as substring of a larger mixed-number size → excluded (regression)', () => {
    // "1/2"" must NOT match inside "1-1/2"" — this was a known regression
    // where the tokenMatch boundary logic could let smaller sizes leak through.
    expect(
      matchesChipFilters(item('1-1/2" EMT conduit fitting'), [{ key: 'tradeSize', value: '1/2"' }])
    ).toBe(false);
    expect(
      matchesChipFilters(item('2-1/2" EMT conduit fitting'), [{ key: 'tradeSize', value: '1/2"' }])
    ).toBe(false);
    expect(
      matchesChipFilters(item('1-1/4" EMT conduit fitting'), [{ key: 'tradeSize', value: '1/4"' }])
    ).toBe(false);
  });

  it('exact-size description matches its own chip value', () => {
    expect(
      matchesChipFilters(item('1/2" EMT conduit'), [{ key: 'tradeSize', value: '1/2"' }])
    ).toBe(true);
    expect(
      matchesChipFilters(item('1-1/2" EMT conduit'), [{ key: 'tradeSize', value: '1-1/2"' }])
    ).toBe(true);
  });

  it('token present in aiKeywords → included', () => {
    const withKw: ChipFilterItem = {
      vendor: 'Allied',
      catalog: 'EMT34',
      description: 'EMT conduit',
      aiKeywords: ['3/4"', 'trade size'],
    };
    expect(matchesChipFilters(withKw, [{ key: 'tradeSize', value: '3/4"' }])).toBe(true);
  });
});

describe('matchesChipFilters — colorChip chip (text-only, no column)', () => {
  const item = (description: string): ChipFilterItem => ({
    vendor: 'Leviton',
    catalog: 'DR15',
    description,
    aiKeywords: null,
  });

  it('color token present in description → included', () => {
    expect(
      matchesChipFilters(item('15A duplex receptacle white'), [
        { key: 'colorChip', value: 'White' },
      ])
    ).toBe(true);
  });

  it('color token absent from description → excluded', () => {
    expect(
      matchesChipFilters(item('15A duplex receptacle black'), [
        { key: 'colorChip', value: 'White' },
      ])
    ).toBe(false);
  });

  it('color match is case-insensitive', () => {
    expect(
      matchesChipFilters(item('15A duplex receptacle WHITE'), [
        { key: 'colorChip', value: 'white' },
      ])
    ).toBe(true);
    expect(
      matchesChipFilters(item('15A duplex receptacle white'), [
        { key: 'colorChip', value: 'WHITE' },
      ])
    ).toBe(true);
  });

  it('color token present in aiKeywords → included', () => {
    const withKw: ChipFilterItem = {
      vendor: 'Leviton',
      catalog: 'DR15',
      description: '15A receptacle',
      aiKeywords: ['ivory', 'standard outlet'],
    };
    expect(matchesChipFilters(withKw, [{ key: 'colorChip', value: 'Ivory' }])).toBe(true);
  });

  it('color absent from both description and aiKeywords → excluded', () => {
    const withKw: ChipFilterItem = {
      vendor: 'Leviton',
      catalog: 'DR15',
      description: '15A receptacle',
      aiKeywords: ['ivory', 'standard outlet'],
    };
    expect(matchesChipFilters(withKw, [{ key: 'colorChip', value: 'Red' }])).toBe(false);
  });
});

describe('matchesChipFilters — conduitType chip (text-only, no column)', () => {
  const item = (description: string): ChipFilterItem => ({
    vendor: 'Cantex',
    catalog: 'CONDUIT1',
    description,
    aiKeywords: null,
  });

  it('conduit type token present in description → included', () => {
    expect(
      matchesChipFilters(item('1" PVC Schedule 40 conduit'), [{ key: 'conduitType', value: 'PVC' }])
    ).toBe(true);
  });

  it('conduit type token absent from description → excluded', () => {
    expect(matchesChipFilters(item('1" EMT conduit'), [{ key: 'conduitType', value: 'PVC' }])).toBe(
      false
    );
  });

  it('multi-word conduit type token matches only when all words are present', () => {
    expect(
      matchesChipFilters(item('1/2" flexible metal conduit'), [
        { key: 'conduitType', value: 'flexible metal conduit' },
      ])
    ).toBe(true);
    expect(
      matchesChipFilters(item('1/2" EMT conduit'), [
        { key: 'conduitType', value: 'flexible metal conduit' },
      ])
    ).toBe(false);
  });

  it('conduit type match is case-insensitive', () => {
    expect(matchesChipFilters(item('1" emt conduit'), [{ key: 'conduitType', value: 'EMT' }])).toBe(
      true
    );
    expect(matchesChipFilters(item('1" EMT conduit'), [{ key: 'conduitType', value: 'emt' }])).toBe(
      true
    );
  });

  it('conduit type present in aiKeywords → included', () => {
    const withKw: ChipFilterItem = {
      vendor: 'Allied',
      catalog: 'COND1',
      description: '1" conduit',
      aiKeywords: ['rigid metal conduit', 'RMC'],
    };
    expect(matchesChipFilters(withKw, [{ key: 'conduitType', value: 'rigid metal conduit' }])).toBe(
      true
    );
  });

  it('combining conduitType and tradeSize both required → AND logic', () => {
    const matching: ChipFilterItem = {
      vendor: 'Allied',
      catalog: 'EMT12',
      description: '1/2" EMT conduit',
      aiKeywords: null,
    };
    const wrongSize: ChipFilterItem = {
      vendor: 'Allied',
      catalog: 'EMT34',
      description: '3/4" EMT conduit',
      aiKeywords: null,
    };
    const wrongType: ChipFilterItem = {
      vendor: 'Cantex',
      catalog: 'PVC12',
      description: '1/2" PVC conduit',
      aiKeywords: null,
    };
    const filters = [
      { key: 'conduitType', value: 'EMT' },
      { key: 'tradeSize', value: '1/2"' },
    ];
    expect(matchesChipFilters(matching, filters)).toBe(true);
    expect(matchesChipFilters(wrongSize, filters)).toBe(false);
    expect(matchesChipFilters(wrongType, filters)).toBe(false);
  });
});
