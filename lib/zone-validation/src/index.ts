/**
 * Pure zone-mapping validation helpers shared between the Zone Editor UI and
 * the test suite.  No external dependencies — safe to import from any context.
 */

export interface ZoneLike {
  id: number;
  aisleId: string;
  sectionNum: number | null;
}

/**
 * Strips leading zeros from a numeric aisle ID string so that "08" and "8"
 * are treated as the same aisle.  Non-numeric strings are returned unchanged
 * after trimming.  E.g. "08" → "8", "012" → "12", "8" → "8", "A1" → "A1".
 */
export function normalizeAisleId(v: string): string {
  const t = v.trim();
  return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t;
}

/**
 * Returns true when `v` is a non-empty string that contains only digit
 * characters after trimming leading/trailing whitespace.  E.g. "12" → true,
 * " 08 " → true, "A1" → false, "" → false.
 */
export function isValidAisleId(v: string): boolean {
  return /^\d+$/.test(normalizeAisleId(v));
}

/**
 * Returns the first zone in `zones` that would conflict with the given
 * `aisleId` + `sectionNum` combination, or `null` when no conflict exists.
 *
 * The zone identified by `excludeId` is skipped (pass the id of the zone
 * currently being edited so it does not conflict with itself).
 *
 * A conflict exists when the same aisleId AND same sectionNum are already used.
 *
 * Both the incoming aisleId and each stored aisleId are normalized (leading
 * zeros stripped, surrounding whitespace trimmed) before comparison, so
 * "08" and "8" (or " 8 ") are detected as the same aisle.
 */
export function findDuplicateConflict<T extends ZoneLike>(
  zones: T[],
  excludeId: number | null,
  aisleId: string,
  sectionNum: number | null,
): T | null {
  if (sectionNum === null) return null;
  const normalized = normalizeAisleId(aisleId);
  return (
    zones.find((z) => {
      if (z.id === excludeId) return false;
      if (normalizeAisleId(z.aisleId) !== normalized) return false;
      return z.sectionNum === sectionNum;
    }) ?? null
  );
}
