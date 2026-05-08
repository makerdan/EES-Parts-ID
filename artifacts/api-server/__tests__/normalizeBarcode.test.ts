/**
 * Pure-function tests for the barcode normalizer used by the
 * /api/barcode/* endpoints. Lives in isolation (no DB / no Express)
 * so it runs in milliseconds and gates the contract on its own.
 */
import { normalizeBarcode } from '../src/utils/normalizeBarcode';

describe('normalizeBarcode', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeBarcode('  ABC123\n')).toBe('ABC123');
  });

  it('upper-cases the result', () => {
    expect(normalizeBarcode('alu2c2')).toBe('ALU2C2');
  });

  it('strips zero-width characters that some QR encoders pad with', () => {
    expect(normalizeBarcode('\u200BABC\u200B')).toBe('ABC');
    expect(normalizeBarcode('ABC\uFEFF')).toBe('ABC');
  });

  it('drops a leading zero pad on a 13-digit numeric (UPC-E → UPC-A normalisation)', () => {
    expect(normalizeBarcode('0123456789012')).toBe('123456789012');
  });

  it('does NOT drop a leading zero on a non-numeric or short input', () => {
    expect(normalizeBarcode('0ABCDE')).toBe('0ABCDE');
    expect(normalizeBarcode('01234')).toBe('01234');
  });

  it('returns empty string for whitespace-only or non-string input', () => {
    expect(normalizeBarcode('   ')).toBe('');
    expect(normalizeBarcode('')).toBe('');
    // @ts-expect-error testing runtime guard
    expect(normalizeBarcode(undefined)).toBe('');
  });
});
