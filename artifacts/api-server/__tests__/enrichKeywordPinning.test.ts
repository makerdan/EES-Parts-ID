/**
 * Unit tests for the keyword-pinning guarantee.
 *
 * Verifies that:
 *   1. mergeWithPinned() always keeps pinned keywords in the final array,
 *      even when the AI returns a completely different set.
 *   2. mergeWithPinned() deduplicates case-insensitively (pinned copy wins).
 *   3. mergeWithPinned() handles empty pinned / empty AI arrays gracefully.
 *   4. Junk AI keywords do NOT evict a pinned keyword via duplicate detection.
 *   5. The Cutler-Hammer / BAB-breaker scenario survives a simulated
 *      re-enrichment run where the AI omits the brand name entirely.
 */

import { mergeWithPinned, isJunkKeyword } from "../src/utils/generateKeywords";

describe("mergeWithPinned", () => {
  it("returns AI keywords unchanged when there are no pinned keywords", () => {
    const ai = ["circuit breaker", "20A", "1 pole"];
    expect(mergeWithPinned(ai, [])).toEqual(ai);
  });

  it("returns pinned keywords unchanged when AI returns nothing", () => {
    const pinned = ["Cutler-Hammer", "BAB breaker"];
    expect(mergeWithPinned([], pinned)).toEqual(pinned);
  });

  it("places pinned keywords first in the merged result", () => {
    const ai = ["circuit breaker", "20A"];
    const pinned = ["Cutler-Hammer"];
    const result = mergeWithPinned(ai, pinned);
    expect(result[0]).toBe("Cutler-Hammer");
  });

  it("deduplicates case-insensitively and keeps the pinned spelling", () => {
    // AI might return "cutler-hammer" (lower-case); pinned has "Cutler-Hammer".
    // The pinned casing wins because pinned keywords are prepended first.
    const ai = ["cutler-hammer", "circuit breaker", "20A"];
    const pinned = ["Cutler-Hammer"];
    const result = mergeWithPinned(ai, pinned);
    expect(result).toContain("Cutler-Hammer");
    expect(result).not.toContain("cutler-hammer");
    expect(result.filter(k => k.toLowerCase() === "cutler-hammer")).toHaveLength(1);
  });

  it("keeps all unique AI keywords that are not in the pinned set", () => {
    const ai = ["circuit breaker", "20A", "1 pole", "120V"];
    const pinned = ["Cutler-Hammer"];
    const result = mergeWithPinned(ai, pinned);
    expect(result).toContain("circuit breaker");
    expect(result).toContain("20A");
    expect(result).toContain("1 pole");
    expect(result).toContain("120V");
    expect(result).toContain("Cutler-Hammer");
  });

  it("handles whitespace-only strings gracefully (strips them)", () => {
    const result = mergeWithPinned(["  ", "circuit breaker"], ["Cutler-Hammer", ""]);
    expect(result).not.toContain("  ");
    expect(result).not.toContain("");
    expect(result).toContain("circuit breaker");
    expect(result).toContain("Cutler-Hammer");
  });

  it("is idempotent: calling twice produces the same output", () => {
    const ai = ["circuit breaker", "Eaton", "20A"];
    const pinned = ["Cutler-Hammer", "BAB breaker"];
    const first = mergeWithPinned(ai, pinned);
    const second = mergeWithPinned(first, pinned);
    expect(second).toEqual(first);
  });

  // ── The core scenario from the task ────────────────────────────────────────
  it("Cutler-Hammer survives a re-enrichment that returns only generic breaker terms", () => {
    // Simulates the state after an admin manually edited keywords to include
    // "Cutler-Hammer" for a BAB-series breaker.
    const pinnedKeywords = [
      "Cutler-Hammer",
      "BAB breaker",
      "circuit breaker",
      "20A",
      "1 pole",
      "120V",
    ];

    // Future enrichment job returns only generic keywords — no brand name.
    const newAiKeywords = [
      "circuit breaker",
      "miniature breaker",
      "panel breaker",
      "20 amp",
      "single pole",
      "120 volt",
    ];

    const result = mergeWithPinned(newAiKeywords, pinnedKeywords);

    // Brand keyword must survive.
    expect(result).toContain("Cutler-Hammer");
    // BAB-specific term must survive.
    expect(result).toContain("BAB breaker");
    // AI-only terms must also be present.
    expect(result).toContain("miniature breaker");
    expect(result).toContain("panel breaker");
    // No duplicates allowed (case-insensitive check for "circuit breaker").
    const circuitBreakerMatches = result.filter(
      k => k.toLowerCase() === "circuit breaker",
    );
    expect(circuitBreakerMatches).toHaveLength(1);
  });

  it("handles multiple pinned keywords all surviving a fully unrelated AI result", () => {
    const pinned = ["Cutler-Hammer", "BAB", "Eaton brand", "legacy breaker"];
    const ai = ["conduit fitting", "1/2 inch", "EMT", "galvanized steel"];
    const result = mergeWithPinned(ai, pinned);
    for (const kw of pinned) {
      expect(result).toContain(kw);
    }
    for (const kw of ai) {
      expect(result).toContain(kw);
    }
  });
});

describe("isJunkKeyword (regression guard)", () => {
  it("marks n/a as junk", () => expect(isJunkKeyword("n/a")).toBe(true));
  it("marks single chars as junk", () => expect(isJunkKeyword("a")).toBe(true));
  it("does not mark Cutler-Hammer as junk", () =>
    expect(isJunkKeyword("Cutler-Hammer")).toBe(false));
  it("does not mark circuit breaker as junk", () =>
    expect(isJunkKeyword("circuit breaker")).toBe(false));
});
