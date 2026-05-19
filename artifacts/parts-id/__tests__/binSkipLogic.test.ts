/**
 * @jest-environment node
 *
 * Unit tests for the bin-replacement skip toggle logic extracted from upload.tsx.
 * Covers:
 *   - toggleSkipRow: adding and removing a single index from the skip set
 *   - toggleSkipAll: skip-all sets all replace indices; restore-all clears them
 *   - activeReplacementCount: decreases as rows are skipped
 *   - preservedBinCount: increases as replace rows are skipped
 *   - serializeToCsv: blanks the bin cell for skipped rows
 */

import {
  toggleSkipRow,
  toggleSkipAll,
  getReplaceIndices,
  activeReplacementCount,
  preservedBinCount,
  serializeToCsv,
  type BinDiffRow,
  type ParsedRow,
} from "../utils/binSkipLogic";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRows(statuses: BinDiffRow["status"][]): BinDiffRow[] {
  return statuses.map((status, i) => ({
    vendor: `Vendor${i}`,
    catalog: `CAT-${i}`,
    status,
    existingBins: [`A${i}`],
    incomingBins: [`B${i}`],
  }));
}

function makeParsedRow(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    vendor: "Acme",
    catalog: "PART-001",
    description: "Widget",
    binLocations: ["A1"],
    barcodes: [],
    ...overrides,
  };
}

// ── toggleSkipRow ─────────────────────────────────────────────────────────

describe("toggleSkipRow", () => {
  it("adds an index that is not yet in the set", () => {
    const next = toggleSkipRow(new Set<number>(), 3);
    expect(next.has(3)).toBe(true);
    expect(next.size).toBe(1);
  });

  it("removes an index that is already in the set", () => {
    const prev = new Set([3, 7]);
    const next = toggleSkipRow(prev, 3);
    expect(next.has(3)).toBe(false);
    expect(next.has(7)).toBe(true);
  });

  it("does not mutate the original set", () => {
    const prev = new Set([1, 2]);
    toggleSkipRow(prev, 1);
    expect(prev.has(1)).toBe(true);
  });

  it("toggling the same index twice returns to the original state", () => {
    const prev = new Set<number>();
    const after1 = toggleSkipRow(prev, 5);
    const after2 = toggleSkipRow(after1, 5);
    expect(after2.has(5)).toBe(false);
    expect(after2.size).toBe(0);
  });
});

// ── getReplaceIndices ─────────────────────────────────────────────────────

describe("getReplaceIndices", () => {
  it("returns only indices whose status is 'replace'", () => {
    const rows = makeRows(["replace", "add", "replace", "preserve", "none"]);
    expect(getReplaceIndices(rows)).toEqual([0, 2]);
  });

  it("returns an empty array when no rows have status 'replace'", () => {
    const rows = makeRows(["add", "preserve", "none"]);
    expect(getReplaceIndices(rows)).toEqual([]);
  });
});

// ── toggleSkipAll ─────────────────────────────────────────────────────────

describe("toggleSkipAll", () => {
  it("skip-all: adds every replace-status index when not all are skipped", () => {
    const rows = makeRows(["replace", "add", "replace"]);
    const result = toggleSkipAll(rows, new Set<number>());
    expect([...result].sort()).toEqual([0, 2]);
  });

  it("skip-all: adds replace indices even when only some were previously skipped", () => {
    const rows = makeRows(["replace", "add", "replace"]);
    const result = toggleSkipAll(rows, new Set([0]));
    expect([...result].sort()).toEqual([0, 2]);
  });

  it("restore-all: clears the set when every replace index was already skipped", () => {
    const rows = makeRows(["replace", "add", "replace"]);
    const result = toggleSkipAll(rows, new Set([0, 2]));
    expect(result.size).toBe(0);
  });

  it("does not include non-replace indices in skip-all", () => {
    const rows = makeRows(["add", "preserve", "replace", "none"]);
    const result = toggleSkipAll(rows, new Set<number>());
    expect([...result]).toEqual([2]);
  });

  it("returns an empty set when there are no replace rows (no-op)", () => {
    const rows = makeRows(["add", "preserve"]);
    const result = toggleSkipAll(rows, new Set<number>());
    expect(result.size).toBe(0);
  });
});

// ── activeReplacementCount ────────────────────────────────────────────────

describe("activeReplacementCount", () => {
  it("equals willReplaceBins when no rows are skipped", () => {
    const rows = makeRows(["replace", "add", "replace"]);
    expect(activeReplacementCount(2, new Set(), rows)).toBe(2);
  });

  it("decreases by 1 when one replace row is skipped", () => {
    const rows = makeRows(["replace", "add", "replace"]);
    expect(activeReplacementCount(2, new Set([0]), rows)).toBe(1);
  });

  it("reaches 0 when all replace rows are skipped", () => {
    const rows = makeRows(["replace", "add", "replace"]);
    expect(activeReplacementCount(2, new Set([0, 2]), rows)).toBe(0);
  });

  it("does not decrease for skipped indices that are not 'replace'", () => {
    const rows = makeRows(["replace", "add", "replace"]);
    expect(activeReplacementCount(2, new Set([1]), rows)).toBe(2);
  });
});

// ── preservedBinCount ─────────────────────────────────────────────────────

describe("preservedBinCount", () => {
  it("equals willPreserveBins when no replace rows are skipped", () => {
    const rows = makeRows(["replace", "add", "preserve"]);
    expect(preservedBinCount(1, new Set(), rows)).toBe(1);
  });

  it("increases by 1 when one replace row is skipped (user chose to keep existing bin)", () => {
    const rows = makeRows(["replace", "add", "preserve"]);
    expect(preservedBinCount(1, new Set([0]), rows)).toBe(2);
  });

  it("increases by the number of skipped replace rows", () => {
    const rows = makeRows(["replace", "add", "replace"]);
    expect(preservedBinCount(0, new Set([0, 2]), rows)).toBe(2);
  });

  it("does not count skipped non-replace rows toward preserved total", () => {
    const rows = makeRows(["replace", "add", "preserve"]);
    expect(preservedBinCount(1, new Set([1]), rows)).toBe(1);
  });
});

// ── serializeToCsv ────────────────────────────────────────────────────────

describe("serializeToCsv", () => {
  const row0 = makeParsedRow({ vendor: "Acme", catalog: "P-01", description: "Widget", binLocations: ["A1", "B2"], barcodes: ["123"] });
  const row1 = makeParsedRow({ vendor: "Beta", catalog: "P-02", description: "Gadget", binLocations: ["C3"], barcodes: [] });

  it("includes bin locations for non-skipped rows", () => {
    const csv = serializeToCsv([row0, row1], new Set<number>());
    const lines = csv.split("\n");
    expect(lines[1]).toContain("A1;B2");
    expect(lines[2]).toContain("C3");
  });

  it("blanks the bin cell for a skipped row", () => {
    const csv = serializeToCsv([row0, row1], new Set([0]));
    const lines = csv.split("\n");
    const fields0 = lines[1].split(",").map(f => f.replace(/^"|"$/g, ""));
    expect(fields0[3]).toBe("");
  });

  it("preserves bin locations for non-skipped rows when others are skipped", () => {
    const csv = serializeToCsv([row0, row1], new Set([0]));
    const lines = csv.split("\n");
    expect(lines[2]).toContain("C3");
  });

  it("blanks every row when all are skipped", () => {
    const csv = serializeToCsv([row0, row1], new Set([0, 1]));
    const lines = csv.split("\n");
    for (let i = 1; i <= 2; i++) {
      const fields = lines[i].split(",").map(f => f.replace(/^"|"$/g, ""));
      expect(fields[3]).toBe("");
    }
  });

  it("always emits the correct CSV header", () => {
    const csv = serializeToCsv([row0], new Set<number>());
    expect(csv.split("\n")[0]).toBe("Vendor,Catalog,Description,BinLocation,Barcodes");
  });

  it("escapes double-quotes in field values", () => {
    const row = makeParsedRow({ description: 'say "hello"', binLocations: [], barcodes: [] });
    const csv = serializeToCsv([row], new Set<number>());
    expect(csv).toContain('say ""hello""');
  });
});
