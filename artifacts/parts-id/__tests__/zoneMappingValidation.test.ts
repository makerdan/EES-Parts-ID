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
import type { SectionParity, ZoneLike } from "@workspace/zone-validation";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeZone(id: number, aisleId: string, sectionParity: SectionParity): ZoneLike {
  return { id, aisleId, sectionParity };
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
});

// ── findDuplicateConflict ─────────────────────────────────────────────────────

describe("findDuplicateConflict", () => {
  it("returns the conflicting zone on an exact match (same aisleId, same parity)", () => {
    const zones = [makeZone(1, "08", "odd")];
    const result = findDuplicateConflict(zones, null, "08", "odd");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it("conflicts when existing zone is 'all' and incoming parity is 'odd'", () => {
    const zones = [makeZone(1, "08", "all")];
    expect(findDuplicateConflict(zones, null, "08", "odd")).not.toBeNull();
  });

  it("conflicts when existing zone is 'all' and incoming parity is 'even'", () => {
    const zones = [makeZone(1, "08", "all")];
    expect(findDuplicateConflict(zones, null, "08", "even")).not.toBeNull();
  });

  it("conflicts when incoming parity is 'all' and existing zone is 'odd'", () => {
    const zones = [makeZone(1, "08", "odd")];
    expect(findDuplicateConflict(zones, null, "08", "all")).not.toBeNull();
  });

  it("conflicts when incoming parity is 'all' and existing zone is 'even'", () => {
    const zones = [makeZone(1, "08", "even")];
    expect(findDuplicateConflict(zones, null, "08", "all")).not.toBeNull();
  });

  it("returns null for same aisleId but non-overlapping parities (odd vs even)", () => {
    const zones = [makeZone(1, "08", "odd")];
    expect(findDuplicateConflict(zones, null, "08", "even")).toBeNull();
  });

  it("returns null when aisleId differs, even if parity matches", () => {
    const zones = [makeZone(1, "08", "all")];
    expect(findDuplicateConflict(zones, null, "12", "all")).toBeNull();
  });

  it("excludes the zone identified by excludeId (the zone being edited)", () => {
    const zones = [makeZone(1, "08", "odd")];
    expect(findDuplicateConflict(zones, 1, "08", "odd")).toBeNull();
  });

  it("does not exclude other zones when excludeId is set", () => {
    const zones = [makeZone(1, "08", "odd"), makeZone(2, "08", "odd")];
    const result = findDuplicateConflict(zones, 1, "08", "odd");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(2);
  });

  it("returns null when the zones list is empty", () => {
    expect(findDuplicateConflict([], null, "08", "all")).toBeNull();
  });

  it("trims whitespace from the aisleId argument before comparing", () => {
    const zones = [makeZone(1, "08", "odd")];
    expect(findDuplicateConflict(zones, null, " 08 ", "odd")).not.toBeNull();
  });

  it("returns the first conflicting zone when multiple conflicts exist", () => {
    const zones = [makeZone(1, "08", "all"), makeZone(2, "08", "odd")];
    const result = findDuplicateConflict(zones, null, "08", "odd");
    expect(result!.id).toBe(1);
  });
});
