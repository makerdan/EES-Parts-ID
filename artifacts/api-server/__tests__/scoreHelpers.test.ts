import {
  blendPgScore,
  catalogScore,
  applyVendorBoost,
  shouldUpdateScore,
  fuseConfidence,
} from '../src/utils/scoreHelpers';

// ── blendPgScore ──────────────────────────────────────────────────────────────
//
// Stage 2 (Task #186) changed the formula from:
//   Math.min(0.95, ftsRank * 0.6 + trgmSim * 0.4 + 0.4)   ← additive 0.4 floor
// to:
//   ftsNorm = ftsRaw / (ftsRaw + 1)                         ← normalize to [0, 1)
//   0.65 * ftsNorm + 0.35 * trgmSim                         ← no additive floor
//
// Rationale: the old 0.4 floor inflated every PG hit to at least 0.40 regardless
// of actual match quality, making ranking scores meaningless. The new formula
// lets weak matches score near zero so the 0.05 noise floor in the search route
// can drop them cleanly, and strong catalog matches (weight A) still dominate.

describe('blendPgScore', () => {
  it('returns 0 for zero fts and zero trgm (no additive floor)', () => {
    // old: 0.4 floor → 0.40; new: no floor → 0
    expect(blendPgScore(0, 0)).toBe(0);
  });

  it('normalizes ftsRaw with ftsRaw/(ftsRaw+1) before blending', () => {
    // ftsRaw=1: ftsNorm = 1/2 = 0.5; blend = 0.65*0.5 + 0.35*0 = 0.325
    expect(blendPgScore(1, 0)).toBeCloseTo(0.325);
    // ftsRaw=0.5: ftsNorm = 0.5/1.5 ≈ 0.333; blend = 0.65*0.333 ≈ 0.217
    expect(blendPgScore(0.5, 0)).toBeCloseTo(0.217, 2);
  });

  it('weights trgmSim at 35%', () => {
    // ftsRaw=0, trgmSim=1: blend = 0.65*0 + 0.35*1 = 0.35
    expect(blendPgScore(0, 1)).toBeCloseTo(0.35);
    // ftsRaw=0, trgmSim=0.5: blend = 0.35*0.5 = 0.175
    expect(blendPgScore(0, 0.5)).toBeCloseTo(0.175);
  });

  it('approaches but never reaches 1.0 as ftsRaw → ∞', () => {
    // ftsNorm approaches 1; blend approaches 0.65+0.35=1.0 but never reaches it for ftsNorm<1
    const score = blendPgScore(1000, 1);
    expect(score).toBeGreaterThan(0.99);
    expect(score).toBeLessThan(1.0);
  });

  it('returns a value in [0, 1) for typical inputs', () => {
    const inputs: [number, number][] = [
      [0.3, 0.6],
      [0.8, 0.2],
      [0.1, 0.9],
      [2, 0.7],
    ];
    for (const [fts, trgm] of inputs) {
      const s = blendPgScore(fts, trgm);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1.0);
    }
  });

  it('gives higher score to a strong fts match than a weak trgm-only match', () => {
    // Strong fts, no trgm
    const strongFts = blendPgScore(2, 0); // ftsNorm=2/3≈0.667; blend≈0.433
    // No fts, moderate trgm
    const weakTrgm = blendPgScore(0, 0.3); // 0.35*0.3 = 0.105
    expect(strongFts).toBeGreaterThan(weakTrgm);
  });

  it('high catalog-weight fts (ts_rank_cd A=1.0) scores significantly above low ai_keyword hit', () => {
    // ts_rank_cd for a catalog (A) hit returns ~1.0; for ai_keyword (D) hit ~0.1
    const catalogHit = blendPgScore(1.0, 0); // ftsNorm=0.5; blend=0.325
    const aiKeywordHit = blendPgScore(0.1, 0); // ftsNorm≈0.091; blend≈0.059
    expect(catalogHit).toBeGreaterThan(aiKeywordHit * 2);
  });
});

// ── catalogScore ──────────────────────────────────────────────────────────────

describe('catalogScore', () => {
  const BASE_PG = 0.55; // arbitrary base PG score used as the non-boosted fallback

  it('returns 1.0 for an exact catalog field match', () => {
    const { score, reason } = catalogScore(BASE_PG, 'BR120', 'BR120', '', 0.2);
    expect(score).toBe(1.0);
    expect(reason).toBe('exact catalog');
  });

  it('returns 1.0 when keywords field exactly matches catalog', () => {
    const { score, reason } = catalogScore(BASE_PG, 'BR120', '', 'BR120', 0.2);
    expect(score).toBe(1.0);
    expect(reason).toBe('exact catalog');
  });

  it('returns max(pgScore, 0.93) for a prefix match', () => {
    const { score, reason } = catalogScore(BASE_PG, 'BR120', 'BR', '', 0.2);
    expect(score).toBeGreaterThanOrEqual(0.93);
    expect(reason).toBe('catalog prefix');
  });

  it('uses pgScore when pgScore > 0.93 on prefix match', () => {
    const highPg = 0.94;
    const { score } = catalogScore(highPg, 'BR120', 'BR', '', 0.8);
    expect(score).toBe(0.94);
  });

  it('returns max(pgScore, 0.85) for a substring match', () => {
    const { score, reason } = catalogScore(BASE_PG, 'BR120', '120', '', 0.2);
    expect(score).toBeGreaterThanOrEqual(0.85);
    expect(reason).toBe('catalog substring');
  });

  it('uses pgScore for FTS hit when no catalog match', () => {
    const { score, reason } = catalogScore(BASE_PG, 'DR15WHI', '', '', 0.4);
    expect(score).toBeCloseTo(BASE_PG);
    expect(reason).toBe('fts match');
  });

  it("labels non-FTS hits as 'trigram match'", () => {
    const { score, reason } = catalogScore(BASE_PG, 'DR15WHI', '', '', 0);
    expect(reason).toBe('trigram match');
  });

  it('exact match takes precedence over prefix', () => {
    // "BR120" catalogInput, catalog "BR120" — should be exact not prefix
    const { reason } = catalogScore(BASE_PG, 'BR120', 'BR120', '', 0.5);
    expect(reason).toBe('exact catalog');
  });

  it('returns pgScore when neither catalogInput nor rawKeywords is given', () => {
    const { score } = catalogScore(BASE_PG, 'BR120', '', '', 0.3);
    expect(score).toBeCloseTo(BASE_PG);
  });

  // ── Multi-word rawKeywords token matching (Photo ID path) ──────────────────

  it('scores 1.0 when one token in a multi-word rawKeywords exactly matches the catalog', () => {
    const { score, reason } = catalogScore(
      BASE_PG,
      'NMWH43',
      '',
      'NMWH43 circuit breaker 20A Square D',
      0.3
    );
    expect(score).toBe(1.0);
    expect(reason).toBe('exact catalog');
  });

  it('scores 1.0 when the exact-match token appears last in rawKeywords', () => {
    const { score, reason } = catalogScore(
      BASE_PG,
      'BR120',
      '',
      'circuit breaker Square D BR120',
      0.3
    );
    expect(score).toBe(1.0);
    expect(reason).toBe('exact catalog');
  });

  it('scores ≥ 0.93 when a token in rawKeywords is a prefix of the catalog', () => {
    const { score, reason } = catalogScore(BASE_PG, 'BR120', '', 'BR circuit breaker 20A', 0.2);
    expect(score).toBeGreaterThanOrEqual(0.93);
    expect(reason).toBe('catalog prefix');
  });

  it('scores ≥ 0.85 when a token in rawKeywords appears as a substring of the catalog', () => {
    const { score, reason } = catalogScore(BASE_PG, 'BR120', '', 'circuit 120 breaker', 0.2);
    expect(score).toBeGreaterThanOrEqual(0.85);
    expect(reason).toBe('catalog substring');
  });

  it('exact token match takes priority over prefix token match', () => {
    const { reason } = catalogScore(BASE_PG, 'BR120', '', 'BR BR120 breaker', 0.2);
    expect(reason).toBe('exact catalog');
  });

  it('falls through to pgScore when no token matches the catalog', () => {
    const { score, reason } = catalogScore(
      BASE_PG,
      'NMWH43',
      '',
      'circuit breaker Square D 20A',
      0.4
    );
    expect(score).toBeCloseTo(BASE_PG);
    expect(reason).toBe('fts match');
  });
});

// ── applyVendorBoost ──────────────────────────────────────────────────────────

describe('applyVendorBoost', () => {
  it('passes confidence through unchanged when no vendor filter is active', () => {
    expect(applyVendorBoost(0.7, '', 'Eaton')).toBeCloseTo(0.7);
  });

  it('adds 0.15 when item vendor matches the filter', () => {
    expect(applyVendorBoost(0.7, 'EATON', 'Eaton')).toBeCloseTo(0.85);
  });

  it('caps the boosted value at 1.0', () => {
    expect(applyVendorBoost(0.95, 'EATON', 'Eaton')).toBe(1.0);
  });

  it('applies a 50% penalty when item vendor does not match the filter', () => {
    expect(applyVendorBoost(0.8, 'EATON', 'Hubbell')).toBeCloseTo(0.4);
  });

  it('is case-insensitive for both vendor filter and item vendor', () => {
    expect(applyVendorBoost(0.7, 'eaton', 'EATON')).toBeCloseTo(0.85);
    expect(applyVendorBoost(0.7, 'EATON', 'eaton')).toBeCloseTo(0.85);
  });
});

// ── shouldUpdateScore ─────────────────────────────────────────────────────────

describe('shouldUpdateScore', () => {
  it('returns true when there is no current score (first encounter)', () => {
    expect(shouldUpdateScore(undefined, 0.7)).toBe(true);
  });

  it('returns true when new confidence is strictly higher', () => {
    expect(shouldUpdateScore(0.5, 0.8)).toBe(true);
  });

  it('returns false when new confidence equals current (no update on tie)', () => {
    expect(shouldUpdateScore(0.7, 0.7)).toBe(false);
  });

  it('returns false when new confidence is lower', () => {
    expect(shouldUpdateScore(0.9, 0.5)).toBe(false);
  });

  it('keeps the highest score when applied in sequence (deduplication)', () => {
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

describe('fuseConfidence', () => {
  it('converts a perfect Fuse score (0) to the maximum weighted confidence', () => {
    // 1 - 0 = 1.0; 1.0 * 0.70 = 0.70
    expect(fuseConfidence(0, 0.7)).toBeCloseTo(0.7);
  });

  it('treats undefined score as 0.5 (middle-of-range default)', () => {
    // 1 - 0.5 = 0.5; 0.5 * 0.70 = 0.35
    expect(fuseConfidence(undefined, 0.7)).toBeCloseTo(0.35);
  });

  it('applies 0.60 weight for expanded-term fallback', () => {
    // score=0, weight=0.60 → 0.60
    expect(fuseConfidence(0, 0.6)).toBeCloseTo(0.6);
  });

  it('returns 0 for a worst-case Fuse score of 1.0', () => {
    // 1 - 1 = 0; 0 * weight = 0
    expect(fuseConfidence(1.0, 0.7)).toBe(0);
  });

  it('returns a mid-range value for an average Fuse score', () => {
    // score=0.3, weight=0.70 → (1 - 0.3) * 0.70 = 0.49
    expect(fuseConfidence(0.3, 0.7)).toBeCloseTo(0.49);
  });
});
