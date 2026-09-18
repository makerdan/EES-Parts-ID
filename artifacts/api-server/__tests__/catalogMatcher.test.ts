/**
 * Unit tests for catalogMatcher.ts
 *
 * The database is fully mocked – no live PostgreSQL connection is required.
 * Tests cover the three matching outcomes: exact hit, partial (trigram) hit,
 * and no hit, as well as the catalog-number normalisation logic.
 */

// ── Chainable DB mock (must be declared before jest.mock is hoisted) ──────────
const mockLimitFn = jest.fn();
const mockOrderByFn = jest.fn(() => ({ limit: mockLimitFn }));
const mockWhereFn = jest.fn(() => ({ limit: mockLimitFn, orderBy: mockOrderByFn }));
const mockFromFn = jest.fn(() => ({ where: mockWhereFn }));
const mockSelectFn = jest.fn(() => ({ from: mockFromFn }));

jest.mock("@workspace/db", () => ({
  db: { select: mockSelectFn },
  inventoryTable: {
    id: "id",
    vendor: "vendor",
    catalog: "catalog",
  },
}));

import { matchCatalogNumber } from "../src/utils/catalogMatcher";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Re-wire the chainable mock after clear
  mockOrderByFn.mockReturnValue({ limit: mockLimitFn });
  mockWhereFn.mockReturnValue({ limit: mockLimitFn, orderBy: mockOrderByFn });
  mockFromFn.mockReturnValue({ where: mockWhereFn });
  mockSelectFn.mockReturnValue({ from: mockFromFn });
  // Default: both queries return empty (no match)
  mockLimitFn.mockResolvedValue([]);
});

// ── Exact hit ─────────────────────────────────────────────────────────────────

describe("exact hit", () => {
  it("returns inventoryId and similarityScore of 1.0 on an exact match", async () => {
    mockLimitFn.mockResolvedValueOnce([{ id: 42 }]);

    const result = await matchCatalogNumber("Eaton", "BR120");

    expect(result).not.toBeNull();
    expect(result!.inventoryId).toBe(42);
    expect(result!.similarityScore).toBe(1.0);
  });

  it("matches when the vendor is supplied in lower-case (vendor is normalised internally)", async () => {
    mockLimitFn.mockResolvedValueOnce([{ id: 7 }]);

    const result = await matchCatalogNumber("eaton", "BR120");

    expect(result).not.toBeNull();
    expect(result!.similarityScore).toBe(1.0);
  });

  it("does not fall through to the trigram query once an exact match is found", async () => {
    mockLimitFn.mockResolvedValueOnce([{ id: 1 }]);

    await matchCatalogNumber("Eaton", "BR120");

    // Only one SQL SELECT should have been issued
    expect(mockSelectFn).toHaveBeenCalledTimes(1);
  });

  it("normalises catalog number by stripping spaces before comparing", async () => {
    // "BR 120" and "BR120" must be treated as the same catalog number
    mockLimitFn.mockResolvedValueOnce([{ id: 99 }]);

    const result = await matchCatalogNumber("Eaton", "BR 120");

    expect(result).not.toBeNull();
    expect(result!.similarityScore).toBe(1.0);
  });
});

// ── Partial (trigram) hit ─────────────────────────────────────────────────────

describe("partial (trigram) hit", () => {
  it("returns inventoryId and the similarity score when only the trigram query matches", async () => {
    // First limit call (exact match) → no result
    mockLimitFn.mockResolvedValueOnce([]);
    // Second limit call (trigram)     → match
    mockLimitFn.mockResolvedValueOnce([{ id: 99, sim: 0.72 }]);

    const result = await matchCatalogNumber("Hubbell", "HBL5262I");

    expect(result).not.toBeNull();
    expect(result!.inventoryId).toBe(99);
    expect(result!.similarityScore).toBeCloseTo(0.72);
  });

  it("issues two SELECT queries when the exact match returns an empty array", async () => {
    mockLimitFn.mockResolvedValueOnce([]);
    mockLimitFn.mockResolvedValueOnce([{ id: 5, sim: 0.55 }]);

    await matchCatalogNumber("Vendor", "PART-001");

    expect(mockSelectFn).toHaveBeenCalledTimes(2);
  });

  it("preserves the similarity score value returned by the trigram query", async () => {
    mockLimitFn.mockResolvedValueOnce([]);
    mockLimitFn.mockResolvedValueOnce([{ id: 3, sim: 0.41 }]);

    const result = await matchCatalogNumber("Leviton", "5262-I");

    expect(result!.similarityScore).toBeCloseTo(0.41);
  });
});

// ── No hit ────────────────────────────────────────────────────────────────────

describe("no hit", () => {
  it("returns null when neither the exact nor the trigram query finds a match", async () => {
    mockLimitFn.mockResolvedValue([]);

    const result = await matchCatalogNumber("Unknown", "XXXXXX");

    expect(result).toBeNull();
  });

  it("returns null for a recognised catalog number under an unknown vendor", async () => {
    mockLimitFn.mockResolvedValue([]);

    const result = await matchCatalogNumber("NoSuchVendor", "BR120");

    expect(result).toBeNull();
  });

  it("returns null when the exact query returns an empty array and trigram also returns empty", async () => {
    mockLimitFn.mockResolvedValueOnce([]);
    mockLimitFn.mockResolvedValueOnce([]);

    const result = await matchCatalogNumber("Eaton", "NOMATCH");

    expect(result).toBeNull();
    expect(mockSelectFn).toHaveBeenCalledTimes(2);
  });
});
