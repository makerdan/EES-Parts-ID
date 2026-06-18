/**
 * Bin location format validation.
 *
 * Expected format: alphanumeric segments separated by dashes.
 * Examples: A-12-3, A1-04, B-02, AA-1-05
 *
 * The regex is intentionally permissive — it catches obvious typos like
 * spaces, slashes, or bare single tokens that have no delimiter at all,
 * while still accepting most warehouse naming conventions.
 */

export const BIN_FORMAT_REGEX = /^[A-Za-z0-9]+([-][A-Za-z0-9]+)+$/;

export const BIN_FORMAT_HINT =
  "Expected format: segments separated by dashes (e.g. A-12-3).";

/**
 * Returns true when the value is empty (no validation needed) or matches
 * the expected bin location format.  Returns false only when a non-empty
 * value looks malformed.
 */
export function isBinLocationValid(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return BIN_FORMAT_REGEX.test(trimmed);
}
