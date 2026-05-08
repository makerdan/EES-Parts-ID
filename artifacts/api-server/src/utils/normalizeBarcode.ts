/**
 * Normalize a scanned barcode string for consistent storage and lookup.
 *
 * Camera scans arrive with various noise that the same physical label
 * can produce on different devices/scans:
 *   - leading/trailing whitespace,
 *   - mixed case (QR payloads can encode arbitrary text),
 *   - zero-width characters (some PDF417/QR encoders pad with U+200B),
 *   - leading "0" check-digit padding for UPC-E → UPC-A expansions
 *     (some scanner libs prepend a 0; we strip it only when the
 *     remaining string is still ≥ 12 chars so we don't damage
 *     genuine catalog codes that legitimately start with "0").
 *
 * The normalizer is pure and side-effect-free so it can be used both
 * server-side (for lookup + storage) and unit-tested in isolation.
 *
 * Returns the empty string for inputs that contain only whitespace.
 */
export function normalizeBarcode(raw: string): string {
  if (typeof raw !== 'string') return '';
  // Strip zero-width chars and trim surrounding whitespace.
  const stripped = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (stripped.length === 0) return '';
  // Upper-case so we can store one canonical form. Codes are typically
  // alphanumeric; vendor codes that include lower-case letters in the
  // catalog field are matched against the catalog table separately.
  let result = stripped.toUpperCase();
  // Drop a single leading "0" pad if doing so still leaves a UPC-A length
  // (12) string. Some scanner libraries pad UPC-E → UPC-A with a leading
  // zero; we want both encodings to map to the same row.
  if (/^0\d{12}$/.test(result)) {
    result = result.slice(1);
  }
  return result;
}
