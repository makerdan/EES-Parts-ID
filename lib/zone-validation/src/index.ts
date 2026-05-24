/**
 * Pure zone-mapping validation helpers shared between the Zone Editor UI and
 * the test suite.  No external dependencies — safe to import from any context.
 */

export type SectionParity = "all" | "odd" | "even";

export interface ZoneLike {
  id: number;
  aisleId: string;
  sectionParity: SectionParity;
}

/**
 * Returns true when `v` is a non-empty string that contains only digit
 * characters after trimming leading/trailing whitespace.  E.g. "12" → true,
 * " 08 " → true, "A1" → false, "" → false.
 */
export function isValidAisleId(v: string): boolean {
  return /^\d+$/.test(v.trim());
}

/**
 * Returns the first zone in `zones` that would conflict with the given
 * `aisleId` + `parity` combination, or `null` when no conflict exists.
 *
 * The zone identified by `excludeId` is skipped (pass the id of the zone
 * currently being edited so it does not conflict with itself).
 *
 * A conflict exists when:
 *   - same aisleId AND same sectionParity (exact duplicate), OR
 *   - same aisleId AND either side is "all" (all overlaps odd/even and
 *     vice-versa).
 */
export function findDuplicateConflict<T extends ZoneLike>(
  zones: T[],
  excludeId: number | null,
  aisleId: string,
  parity: SectionParity,
): T | null {
  const trimmed = aisleId.trim();
  return (
    zones.find((z) => {
      if (z.id === excludeId) return false;
      if (z.aisleId !== trimmed) return false;
      return (
        z.sectionParity === parity ||
        z.sectionParity === "all" ||
        parity === "all"
      );
    }) ?? null
  );
}
