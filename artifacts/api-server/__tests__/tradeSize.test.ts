/**
 * Unit tests for the server-side trade-size parser/formatter that drives
 * the Trade Size filter chip and the aiKeywords backfill.
 */
import {
  parseTradeSizeInches,
  isConduitOrPipe,
  tradeSizeChipLabel,
  tradeSizeKeywordTokens,
  deriveTradeSizeTokens,
} from '../src/utils/tradeSize';

describe('parseTradeSizeInches', () => {
  it.each([
    // Fraction-code encoding (unchanged behavior)
    ['IMC12', 0.5],
    ['IMC34', 0.75],
    ['IMC212', 2.5],
    ['EMT114', 1.25],
    ['EMT112', 1.5],
    ['EMT100', 1],
    ['EMT400', 4],
    ['PVC2', 2],
    // Decimal×100 encoding — 2-digit bare codes
    ['EMT75', 0.75],
    ['EMT50', 0.5],
    ['EMT25', 0.25],
    // Decimal×100 encoding — 3-digit codes (whole + fractional)
    ['EMT150', 1.5],
    ['EMT250', 2.5],
    ['EMT350', 3.5],
    ['EMT175', 1.75],
    ['EMT125', 1.25],
    ['EMT075', 0.75],
    ['EMT050', 0.5],
  ])('parses %s → %s"', (code, inches) => {
    expect(parseTradeSizeInches(code)).toBeCloseTo(inches, 5);
  });

  it.each([['BR120'], ['BR15'], [''], ['EMT'], ['RANDOM999']])('returns null for %s', (code) => {
    expect(parseTradeSizeInches(code as string)).toBe(null);
  });
});

describe('isConduitOrPipe', () => {
  it('flags conduit type abbreviations', () => {
    expect(isConduitOrPipe('IMC212')).toBe(true);
    expect(isConduitOrPipe('EMT34')).toBe(true);
    expect(isConduitOrPipe('FMC12')).toBe(true);
    expect(isConduitOrPipe('LFMC34')).toBe(true);
  });

  it('flags conduit fittings and accessories', () => {
    expect(isConduitOrPipe('EMT34 Coupling')).toBe(true);
    expect(isConduitOrPipe(null, undefined, 'PVC sched 40 elbow')).toBe(true);
    expect(isConduitOrPipe(null, null, '1/2 in EMT Fitting')).toBe(true);
    expect(isConduitOrPipe(null, null, '3/4 in Conduit Locknut')).toBe(true);
    expect(isConduitOrPipe(null, null, '1 in Conduit Bushing')).toBe(true);
    expect(isConduitOrPipe(null, null, '2 in Conduit Reducer')).toBe(true);
    expect(isConduitOrPipe(null, null, 'EMT Offset 1/2')).toBe(true);
    expect(isConduitOrPipe(null, null, 'Conduit Clamp 3/4"')).toBe(true);
    expect(isConduitOrPipe(null, null, 'EMT Hanger 1"')).toBe(true);
    expect(isConduitOrPipe(null, null, 'Conduit Sweep 90 1/2"')).toBe(true);
  });

  it('flags items with FITTING in description (regression: FITTING was missing)', () => {
    expect(isConduitOrPipe('PFA7LR075', 'NEC', '3/4 AL FORM 7 LR FITTING')).toBe(true);
    expect(isConduitOrPipe('GUAB59', 'CRS', '1-1/2" GUAB FITTING')).toBe(true);
    expect(isConduitOrPipe('CGE193', 'CRS', '1/2" NPT 90D MALE CORD/CABLE FITTING')).toBe(true);
  });

  it('returns false for non-conduit items', () => {
    expect(isConduitOrPipe('BR120 20A breaker')).toBe(false);
    expect(isConduitOrPipe('Duplex receptacle')).toBe(false);
  });
});

describe('tradeSizeChipLabel', () => {
  it('matches the FilterPanel chip option strings', () => {
    expect(tradeSizeChipLabel(0.5)).toBe('1/2"');
    expect(tradeSizeChipLabel(0.75)).toBe('3/4"');
    expect(tradeSizeChipLabel(1)).toBe('1"');
    expect(tradeSizeChipLabel(1.25)).toBe('1-1/4"');
    expect(tradeSizeChipLabel(1.5)).toBe('1-1/2"');
    expect(tradeSizeChipLabel(2)).toBe('2"');
    expect(tradeSizeChipLabel(2.5)).toBe('2-1/2"');
    expect(tradeSizeChipLabel(4)).toBe('4"');
  });
});

describe('tradeSizeKeywordTokens', () => {
  it('includes chip label plus natural-language variants', () => {
    const t = tradeSizeKeywordTokens(0.5);
    expect(t).toEqual(expect.arrayContaining(['1/2"', '1/2', '1/2 inch', '1/2 in', '0.5"']));
  });

  it('includes both dash and space forms for mixed numbers', () => {
    const t = tradeSizeKeywordTokens(1.25);
    expect(t).toEqual(expect.arrayContaining(['1-1/4"', '1-1/4', '1 1/4', '1-1/4 inch']));
  });

  describe('fractional size (1/2")', () => {
    it('includes all abbreviated inch variants', () => {
      const t = tradeSizeKeywordTokens(0.5);
      expect(t).toEqual(
        expect.arrayContaining([
          '1/2 in.',
          '1/2in.',
          '1/2 in',
          '1/2in',
          '1/2inch',
          '1/2 inch',
          '1/2 inches',
          '1/2inches',
        ])
      );
    });

    it('includes decimal variants', () => {
      const t = tradeSizeKeywordTokens(0.5);
      expect(t).toEqual(
        expect.arrayContaining([
          '0.5"',
          '0.5in.',
          '0.5 in.',
          '0.5in',
          '0.5 in',
          '0.5inch',
          '0.5 inch',
          '0.5 inches',
        ])
      );
    });
  });

  describe('whole-number size (2")', () => {
    it('includes all abbreviated inch variants', () => {
      const t = tradeSizeKeywordTokens(2);
      expect(t).toEqual(
        expect.arrayContaining([
          '2 in.',
          '2in.',
          '2 in',
          '2in',
          '2inch',
          '2 inch',
          '2 inches',
          '2inches',
        ])
      );
    });
  });

  describe('mixed-number size (1-1/2")', () => {
    it('includes all abbreviated inch variants for dash form', () => {
      const t = tradeSizeKeywordTokens(1.5);
      expect(t).toEqual(
        expect.arrayContaining([
          '1-1/2 in.',
          '1-1/2in.',
          '1-1/2 in',
          '1-1/2in',
          '1-1/2inch',
          '1-1/2 inch',
          '1-1/2 inches',
          '1-1/2inches',
        ])
      );
    });

    it('includes all abbreviated inch variants for space form', () => {
      const t = tradeSizeKeywordTokens(1.5);
      expect(t).toEqual(
        expect.arrayContaining([
          '1 1/2 in.',
          '1 1/2in.',
          '1 1/2 in',
          '1 1/2in',
          '1 1/2inch',
          '1 1/2 inch',
          '1 1/2 inches',
          '1 1/2inches',
        ])
      );
    });

    it('includes decimal form variants', () => {
      const t = tradeSizeKeywordTokens(1.5);
      expect(t).toEqual(
        expect.arrayContaining([
          '1.5"',
          '1.5in.',
          '1.5 in.',
          '1.5in',
          '1.5 in',
          '1.5inch',
          '1.5 inch',
          '1.5 inches',
        ])
      );
    });
  });

  it('does not contain duplicate tokens', () => {
    for (const inches of [0.5, 1, 1.25, 1.5, 2, 2.5]) {
      const t = tradeSizeKeywordTokens(inches);
      const unique = new Set(t);
      expect(unique.size).toBe(t.length);
    }
  });
});

describe('deriveTradeSizeTokens', () => {
  it('derives tokens from a conduit catalog code', () => {
    const t = deriveTradeSizeTokens({
      vendor: 'ALL',
      catalog: 'IMC212',
      description: 'IMC conduit',
    });
    expect(t[0]).toBe('2-1/2"');
  });

  it('returns [] for non-conduit items even with parseable digits', () => {
    expect(
      deriveTradeSizeTokens({ vendor: 'ETN', catalog: 'BR120', description: '20A breaker' })
    ).toEqual([]);
  });

  it('falls back to description when catalog has no parseable size', () => {
    const t = deriveTradeSizeTokens({
      vendor: 'X',
      catalog: 'FOO',
      description: 'EMT 1/2 conduit ABC EMT12',
    });
    expect(t).toContain('1/2"');
  });
});
