import {
  blendPgScore,
  catalogScore,
  applyVendorBoost,
  shouldUpdateScore,
  fuseConfidence,
} from "../src/utils/scoreHelpers";

// ── blendPgScore ──────────────────────────────────────────────────────────────

describe("blendPgScore", () => {
  it("applies the 0.4 floor so even zero fts/trgm scores start above Fuse range", () => {
    const score = blendPgScore(0, 0);
    expect(score).toBeCloseTo(0.4);
  });

  it("weights ftsRank at 60% and trgmSim at 40%", () => {
    // ftsRank=0.5, trgmSim=0 → 0.5*0.6 + 0*0.4 + 0.4 = 0.7
    expect(blendPgScore(0.5, 0)).toBeCloseTo(0.7);
    // ftsRank=0, trgmSim=0.5 → 0*0.6 + 0.5*0.4 + 0.4 = 0.6
    expect(blendPgScore(0, 0.5)).toBeCloseTo(0.6);
  });

  it("caps the result at 0.95", () => {
    // With high ranks, raw value exceeds 0.95
    expect(blendPgScore(1.0, 1.0)).toBe(0.95);
    expect(blendPgScore(10, 10)).toBe(0.95);
  });

  it("returns a value between 0 and 0.95 for typical inputs", () => {
    const score = blendPgScore(0.3, 0.6);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(0.95);
  });
});

// ── catalogScore ──────────────────────────────────────────────────────────────

describe("catalogScore", () => {
  const BASE_PG = 0.55; // arbitrary base PG score used as the non-boosted fallback

  it("returns 1.0 for an exact catalog field match", () => {
    const { score, reason } = catalogScore(BASE_PG, "BR120", "BR120", "", 0.2);
    expect(score).toBe(1.0);
    expect(reason).toBe("exact catalog");
  });

  it("returns 1.0 when keywords field exactly matches catalog", () => {
    const { score, reason } = catalogScore(BASE_PG, "BR120", "", "BR120", 0.2);
    expect(score).toBe(1.0);
    expect(reason).toBe("exact catalog");
  });

  it("returns max(pgScore, 0.93) for a prefix match", () => {
    const { score, reason } = catalogScore(BASE_PG, "BR120", "BR", "", 0.2);
    expect(score).toBeGreaterThanOrEqual(0.93);
    expect(reason).toBe("catalog prefix");
  });

  it("uses pgScore when pgScore > 0.93 on prefix match", () => {
    const highPg = 0.94;
    const { score } = catalogScore(highPg, "BR120", "BR", "", 0.8);
    expect(score).toBe(0.94);
  });

  it("returns max(pgScore, 0.85) for a substring match", () => {
    const { score, reason } = catalogScore(BASE_PG, "BR120", "120", "", 0.2);
    expect(score).toBeGreaterThanOrEqual(0.85);
    expect(reason).toBe("catalog substring");
  });

  it("uses pgScore for FTS hit when no catalog match", () => {
    const { score, reason } = catalogScore(BASE_PG, "DR15WHI", "", "", 0.4);
    expect(score).toBeCloseTo(BASE_PG);
    expect(reason).toBe("fts match");
  });

  it("labels non-FTS hits as 'trigram match'", () => {
    const { score, reason } = catalogScore(BASE_PG, "DR15WHI", "", "", 0);
    expect(reason).toBe("trigram match");
  });

  it("exact match takes precedence over prefix", () => {
    // "BR120" catalogInput, catalog "BR120" — should be exact not prefix
    const { reason } = catalogScore(BASE_PG, "BR120", "BR120", "", 0.5);
    expect(reason).toBe("exact catalog");
  });

  it("returns pgScore when neither catalogInput nor rawKeywords is given", () => {
    const { score } = catalogScore(BASE_PG, "BR120", "", "", 0.3);
    expect(score).toBeCloseTo(BASE_PG);
  });
});

// ── applyVendorBoost ──────────────────────────────────────────────────────────

describe("applyVendorBoost", () => {
  it("passes confidence through unchanged when no vendor filter is active", () => {
    expect(applyVendorBoost(0.7, "", "Eaton")).toBeCloseTo(0.7);
  });

  it("adds 0.15 when item vendor matches the filter", () => {
    expect(applyVendorBoost(0.7, "EATON", "Eaton")).toBeCloseTo(0.85);
  });

  it("caps the boosted value at 1.0", () => {
    expect(applyVendorBoost(0.95, "EATON", "Eaton")).toBe(1.0);
  });

  it("applies a 50% penalty when item vendor does not match the filter", () => {
    expect(applyVendorBoost(0.8, "EATON", "Hubbell")).toBeCloseTo(0.4);
  });

  it("is case-insensitive for both vendor filter and item vendor", () => {
    expect(applyVendorBoost(0.7, "eaton", "EATON")).toBeCloseTo(0.85);
    expect(applyVendorBoost(0.7, "EATON", "eaton")).toBeCloseTo(0.85);
  });
});

// ── shouldUpdateScore ─────────────────────────────────────────────────────────

describe("shouldUpdateScore", () => {
  it("returns true when there is no current score (first encounter)", () => {
    expect(shouldUpdateScore(undefined, 0.7)).toBe(true);
  });

  it("returns true when new confidence is strictly higher", () => {
    expect(shouldUpdateScore(0.5, 0.8)).toBe(true);
  });

  it("returns false when new confidence equals current (no update on tie)", () => {
    expect(shouldUpdateScore(0.7, 0.7)).toBe(false);
  });

  it("returns false when new confidence is lower", () => {
    expect(shouldUpdateScore(0.9, 0.5)).toBe(false);
  });

  it("keeps the highest score when applied in sequence (deduplication)", () => {
    const scores: Record<number, number> = {};
    const update = (id: number, conf: number) => {
      if (shouldUpdateScore(scores[id], conf)) scores[id] = conf;
    };
    update(1, 0.6);
    update(1, 0.9); // should win
    update(1, 0.4); // should lose
    expect(scores[1]).toBeCloseTo(0.9);
  });
});

// ── fuseConfidence ────────────────────────────────────────────────────────────

describe("fuseConfidence", () => {
  it("converts a perfect Fuse score (0) to the maximum weighted confidence", () => {
    // 1 - 0 = 1.0; 1.0 * 0.70 = 0.70
    expect(fuseConfidence(0, 0.70)).toBeCloseTo(0.70);
  });

  it("treats undefined score as 0.5 (middle-of-range default)", () => {
    // 1 - 0.5 = 0.5; 0.5 * 0.70 = 0.35
    expect(fuseConfidence(undefined, 0.70)).toBeCloseTo(0.35);
  });

  it("applies 0.60 weight for expanded-term fallback", () => {
    // score=0, weight=0.60 → 0.60
    expect(fuseConfidence(0, 0.60)).toBeCloseTo(0.60);
  });

  it("returns 0 for a worst-case Fuse score of 1.0", () => {
    // 1 - 1 = 0; 0 * weight = 0
    expect(fuseConfidence(1.0, 0.70)).toBe(0);
  });

  it("returns a mid-range value for an average Fuse score", () => {
    // score=0.3, weight=0.70 → (1 - 0.3) * 0.70 = 0.49
    expect(fuseConfidence(0.3, 0.70)).toBeCloseTo(0.49);
  });
});
