/**
 * @jest-environment node
 *
 * Unit tests for the pure search-helper utilities extracted from SearchScreen.
 * Covers:
 *   - pruneExpired: TTL eviction of query-cache entries
 *   - buildSearchBody: all fields forwarded, chip-dimension combos, categorySlug branch
 *   - buildQueryKey: determinism and key differentiation
 *   - formatStaleCacheWarning: staleness label variants
 *   - formatRelativeAge: relative-time label variants
 */

import {
  pruneExpired,
  buildSearchBody,
  buildQueryKey,
  formatStaleCacheWarning,
  formatRelativeAge,
  CACHE_TTL_MS,
} from "../utils/searchHelpers";
import type { QueryCache } from "../utils/searchHelpers";

// ── Minimal FilterValues stub (mirrors the real interface shape) ───────────────
type FilterValues = {
  keywords: string;
  catalog: string;
  vendor: string;
  color: string;
  size: string;
  material: string;
  textNumbers: string;
  confidenceThreshold: number;
  minLength: string;
  maxLength: string;
  category: string;
  amperage: string;
  colorChip: string;
  manufacturer: string;
  sizeChip: string;
  rating: string;
  wireType: string;
  wireGauge: string;
  conduitType: string;
  conduitSize: string;
  boxType: string;
  boxGangCount: string;
  mountingType: string;
  environment: string;
  voltage: string;
  poleCount: string;
};

const BLANK: FilterValues = {
  keywords: "",
  catalog: "",
  vendor: "",
  color: "",
  size: "",
  material: "",
  textNumbers: "",
  confidenceThreshold: 50,
  minLength: "",
  maxLength: "",
  category: "",
  amperage: "",
  colorChip: "",
  manufacturer: "",
  sizeChip: "",
  rating: "",
  wireType: "",
  wireGauge: "",
  conduitType: "",
  conduitSize: "",
  boxType: "",
  boxGangCount: "",
  mountingType: "",
  environment: "",
  voltage: "",
  poleCount: "",
};

// ── pruneExpired ──────────────────────────────────────────────────────────────

describe("pruneExpired", () => {
  const now = Date.now();

  it("keeps entries younger than the TTL", () => {
    const cache: QueryCache = {
      fresh: { timestamp: now - 1000, results: [] },
    };
    expect(pruneExpired(cache)).toEqual(cache);
  });

  it("removes entries older than the TTL", () => {
    const cache: QueryCache = {
      stale: { timestamp: now - CACHE_TTL_MS - 1, results: [] },
    };
    expect(pruneExpired(cache)).toEqual({});
  });

  it("keeps only the non-expired entries in a mixed cache", () => {
    const cache: QueryCache = {
      old: { timestamp: now - CACHE_TTL_MS - 500, results: [] },
      fresh: { timestamp: now - 100, results: [1] },
    };
    const out = pruneExpired(cache);
    expect(Object.keys(out)).toEqual(["fresh"]);
    expect(out.fresh.results).toEqual([1]);
  });

  it("returns an empty object when all entries are expired", () => {
    const cache: QueryCache = {
      a: { timestamp: 0, results: [] },
      b: { timestamp: 1, results: [] },
    };
    expect(pruneExpired(cache)).toEqual({});
  });

  it("does not mutate the input cache", () => {
    const cache: QueryCache = {
      old: { timestamp: 0, results: [] },
      fresh: { timestamp: now, results: [] },
    };
    const before = JSON.stringify(cache);
    pruneExpired(cache);
    expect(JSON.stringify(cache)).toBe(before);
  });

  it("respects a custom ttlMs override", () => {
    const shortTTL = 5_000; // 5 s
    const cache: QueryCache = {
      // 10 s old — expired under short TTL but fresh under default
      a: { timestamp: now - 10_000, results: [] },
    };
    expect(pruneExpired(cache, shortTTL)).toEqual({});
    expect(pruneExpired(cache)).toEqual(cache); // still fresh under default 24 h TTL
  });
});

// ── buildSearchBody ───────────────────────────────────────────────────────────

describe("buildSearchBody", () => {
  it("includes all FilterValues fields in the output", () => {
    const f: FilterValues = {
      ...BLANK,
      keywords: "breaker",
      catalog: "CAT-123",
      vendor: "Siemens",
      color: "gray",
      size: "large",
      material: "steel",
      textNumbers: "100",
      confidenceThreshold: 70,
    };
    const body = buildSearchBody(f);
    expect(body.keywords).toBe("breaker");
    expect(body.catalog).toBe("CAT-123");
    expect(body.vendor).toBe("Siemens");
    expect(body.color).toBe("gray");
    expect(body.size).toBe("large");
    expect(body.material).toBe("steel");
    expect(body.textNumbers).toBe("100");
    expect(body.confidenceThreshold).toBe(70);
  });

  it("includes all 16 chip-dimension fields in the output", () => {
    const f: FilterValues = { ...BLANK };
    const body = buildSearchBody(f);
    const chipKeys = [
      "category", "amperage", "colorChip", "manufacturer", "sizeChip",
      "rating", "wireType", "wireGauge", "conduitType", "conduitSize",
      "boxType", "boxGangCount", "mountingType", "environment", "voltage",
      "poleCount",
    ];
    for (const key of chipKeys) {
      expect(Object.prototype.hasOwnProperty.call(body, key)).toBe(true);
    }
  });

  it("passes chip filter values through unchanged", () => {
    const f: FilterValues = {
      ...BLANK,
      category: "Breaker",
      voltage: "120V",
      amperage: "20A",
    };
    const body = buildSearchBody(f);
    expect(body.category).toBe("Breaker");
    expect(body.voltage).toBe("120V");
    expect(body.amperage).toBe("20A");
  });

  it("handles a full 3-chip combination (category + voltage + amperage)", () => {
    const f: FilterValues = {
      ...BLANK,
      category: "Breaker",
      voltage: "240V",
      amperage: "30A",
    };
    const body = buildSearchBody(f);
    expect(body.category).toBe("Breaker");
    expect(body.voltage).toBe("240V");
    expect(body.amperage).toBe("30A");
    // Other chips remain blank
    expect(body.wireType).toBe("");
    expect(body.conduitType).toBe("");
  });

  it("handles a conduit-specific chip combination (conduitType + conduitSize + mountingType)", () => {
    const f: FilterValues = {
      ...BLANK,
      category: "Conduit",
      conduitType: "EMT",
      conduitSize: '1"',
      mountingType: "Surface",
    };
    const body = buildSearchBody(f);
    expect(body.conduitType).toBe("EMT");
    expect(body.conduitSize).toBe('1"');
    expect(body.mountingType).toBe("Surface");
  });

  it("omits categorySlug when not provided", () => {
    const body = buildSearchBody(BLANK);
    expect(Object.prototype.hasOwnProperty.call(body, "categorySlug")).toBe(false);
  });

  it("omits categorySlug when null is passed", () => {
    const body = buildSearchBody(BLANK, null);
    expect(Object.prototype.hasOwnProperty.call(body, "categorySlug")).toBe(false);
  });

  it("includes categorySlug when a non-empty string is passed", () => {
    const body = buildSearchBody(BLANK, "wire");
    expect(body.categorySlug).toBe("wire");
  });
});

// ── buildQueryKey ─────────────────────────────────────────────────────────────

describe("buildQueryKey", () => {
  it("produces the same key for identical filters", () => {
    expect(buildQueryKey(BLANK)).toBe(buildQueryKey(BLANK));
  });

  it("produces a different key when a text field changes", () => {
    const a = { ...BLANK, keywords: "wire" };
    const b = { ...BLANK, keywords: "conduit" };
    expect(buildQueryKey(a)).not.toBe(buildQueryKey(b));
  });

  it("produces a different key when a chip field changes", () => {
    const a = { ...BLANK, category: "Breaker" };
    const b = { ...BLANK, category: "Wire" };
    expect(buildQueryKey(a)).not.toBe(buildQueryKey(b));
  });

  it("produces a different key when confidenceThreshold changes", () => {
    const a = { ...BLANK, confidenceThreshold: 50 };
    const b = { ...BLANK, confidenceThreshold: 80 };
    expect(buildQueryKey(a)).not.toBe(buildQueryKey(b));
  });

  it("returns a non-empty string", () => {
    expect(buildQueryKey(BLANK).length).toBeGreaterThan(0);
  });
});

// ── formatStaleCacheWarning ───────────────────────────────────────────────────

describe("formatStaleCacheWarning", () => {
  it("returns the unknown-sync message when syncedAt is null", () => {
    expect(formatStaleCacheWarning(null)).toBe(
      "Data may be outdated — sync time unknown",
    );
  });

  it("returns 'last synced today' when synced within the last 24 hours", () => {
    const syncedAt = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
    expect(formatStaleCacheWarning(syncedAt)).toBe(
      "Data may be outdated — last synced today",
    );
  });

  it("returns '1 day ago' when synced ~25 hours ago", () => {
    const syncedAt = Date.now() - 25 * 60 * 60 * 1000;
    expect(formatStaleCacheWarning(syncedAt)).toBe(
      "Data may be outdated — last synced 1 day ago",
    );
  });

  it("returns the correct plural day count when synced multiple days ago", () => {
    const syncedAt = Date.now() - 3 * 24 * 60 * 60 * 1000;
    expect(formatStaleCacheWarning(syncedAt)).toBe(
      "Data may be outdated — last synced 3 days ago",
    );
  });
});

// ── formatRelativeAge ─────────────────────────────────────────────────────────

describe("formatRelativeAge", () => {
  it("returns 'just now' when the timestamp is less than a minute ago", () => {
    expect(formatRelativeAge(Date.now() - 30_000)).toBe("Last updated just now");
  });

  it("uses singular 'minute' for exactly 1 minute ago", () => {
    expect(formatRelativeAge(Date.now() - 60_000)).toBe(
      "Last updated 1 minute ago",
    );
  });

  it("uses plural 'minutes' for more than 1 minute ago", () => {
    expect(formatRelativeAge(Date.now() - 5 * 60_000)).toBe(
      "Last updated 5 minutes ago",
    );
  });

  it("switches to hours once past 60 minutes", () => {
    expect(formatRelativeAge(Date.now() - 2 * 60 * 60_000)).toBe(
      "Last updated 2 hours ago",
    );
  });

  it("uses singular 'hour' for exactly 1 hour ago", () => {
    expect(formatRelativeAge(Date.now() - 1 * 60 * 60_000)).toBe(
      "Last updated 1 hour ago",
    );
  });

  it("switches to days once past 24 hours", () => {
    expect(formatRelativeAge(Date.now() - 2 * 24 * 60 * 60_000)).toBe(
      "Last updated 2 days ago",
    );
  });

  it("uses singular 'day' for exactly 1 day ago", () => {
    expect(formatRelativeAge(Date.now() - 24 * 60 * 60_000)).toBe(
      "Last updated 1 day ago",
    );
  });
});
