/**
 * @jest-environment node
 *
 * Unit tests for the pure validation helpers from @workspace/zone-validation:
 *   - isValidAisleId
 *   - findDuplicateConflict
 *
 * These functions are defined in lib/zone-validation/src/index.ts and imported
 * by ZoneEditor.tsx.  Testing from the real module ensures regressions in the
 * production implementation are caught by this suite.
 */

import {
  isValidAisleId,
  findDuplicateConflict,
} from "@workspace/zone-validation";
import type { ZoneLike } from "@workspace/zone-validation";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeZone(id: number, aisleId: string, sectionNum: number): ZoneLike {
  return { id, aisleId, sectionNum };
}

// ── isValidAisleId ────────────────────────────────────────────────────────────

describe("isValidAisleId", () => {
  it("accepts a multi-digit numeric string", () => {
    expect(isValidAisleId("12")).toBe(true);
  });

  it("accepts a single-digit numeric string", () => {
    expect(isValidAisleId("0")).toBe(true);
  });

  it("accepts zero-padded numbers", () => {
    expect(isValidAisleId("08")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidAisleId("")).toBe(false);
  });

  it("rejects a string containing only whitespace", () => {
    expect(isValidAisleId("   ")).toBe(false);
  });

  it("rejects purely alphabetic strings", () => {
    expect(isValidAisleId("abc")).toBe(false);
  });

  it("rejects mixed alphanumeric — letter suffix", () => {
    expect(isValidAisleId("12a")).toBe(false);
  });

  it("rejects mixed alphanumeric — letter prefix", () => {
    expect(isValidAisleId("A1")).toBe(false);
  });

  it("trims leading and trailing spaces before validating", () => {
    expect(isValidAisleId(" 12 ")).toBe(true);
    expect(isValidAisleId(" 08 ")).toBe(true);
  });

  it("rejects negative number strings", () => {
    expect(isValidAisleId("-1")).toBe(false);
  });

  it("rejects decimal / fractional strings", () => {
    expect(isValidAisleId("3.5")).toBe(false);
  });

  it("rejects strings containing only whitespace", () => {
    expect(isValidAisleId("  ")).toBe(false);
  });
});

// ── findDuplicateConflict ─────────────────────────────────────────────────────

describe("findDuplicateConflict", () => {
  it("returns the conflicting zone on an exact match (same aisleId, same sectionNum)", () => {
    const zones = [makeZone(1, "08", 1)];
    const result = findDuplicateConflict(zones, null, "08", 1);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it("returns null for same aisleId but different sectionNum", () => {
    const zones = [makeZone(1, "08", 1)];
    expect(findDuplicateConflict(zones, null, "08", 2)).toBeNull();
  });

  it("returns null when aisleId differs, even if sectionNum matches", () => {
    const zones = [makeZone(1, "08", 1)];
    expect(findDuplicateConflict(zones, null, "12", 1)).toBeNull();
  });

  it("excludes the zone identified by excludeId (the zone being edited)", () => {
    const zones = [makeZone(1, "08", 1)];
    expect(findDuplicateConflict(zones, 1, "08", 1)).toBeNull();
  });

  it("does not exclude other zones when excludeId is set", () => {
    const zones = [makeZone(1, "08", 1), makeZone(2, "08", 1)];
    const result = findDuplicateConflict(zones, 1, "08", 1);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(2);
  });

  it("returns null when the zones list is empty", () => {
    expect(findDuplicateConflict([], null, "08", 1)).toBeNull();
  });

  it("trims whitespace from the aisleId argument before comparing", () => {
    const zones = [makeZone(1, "08", 1)];
    expect(findDuplicateConflict(zones, null, " 08 ", 1)).not.toBeNull();
  });

  it("returns the first conflicting zone when multiple conflicts exist", () => {
    const zones = [makeZone(1, "08", 1), makeZone(2, "08", 1)];
    const result = findDuplicateConflict(zones, null, "08", 1);
    expect(result!.id).toBe(1);
  });

  it("treats '08' and '8' as the same aisle (leading-zero equivalence)", () => {
    const zones = [makeZone(1, "8", 1)];
    expect(findDuplicateConflict(zones, null, "08", 1)).not.toBeNull();
  });

  it("treats '8' and '08' as the same aisle (reverse direction)", () => {
    const zones = [makeZone(1, "08", 1)];
    expect(findDuplicateConflict(zones, null, "8", 1)).not.toBeNull();
  });

  it("detects a conflict when the stored aisleId has a trailing space", () => {
    const zones = [makeZone(1, "8 ", 1)];
    expect(findDuplicateConflict(zones, null, "8", 1)).not.toBeNull();
  });

  it("detects a conflict when the stored aisleId has a leading space", () => {
    const zones = [makeZone(1, " 8", 1)];
    expect(findDuplicateConflict(zones, null, "8", 1)).not.toBeNull();
  });
});
