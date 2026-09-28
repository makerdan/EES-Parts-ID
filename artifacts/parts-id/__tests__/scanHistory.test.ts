/**
 * @jest-environment node
 *
 * Unit tests for the scan-history utilities.
 * Covers:
 *   - prependEntry: prepend, deduplication, MAX_ENTRIES cap
 *   - groupScansByDate: "Today" / "Yesterday" / named-month labels, ordering,
 *     multiple entries in a single group, empty input
 *   - isValidScanEntry: accepts valid server entries and rejects malformed data
 */

import {
  prependEntry,
  groupScansByDate,
  isValidScanEntry,
} from "../utils/scanHistory";
import type { ScanEntry, ScanGroup } from "../utils/scanHistory";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(barcode: string, found = true, timestamp?: string): ScanEntry {
  return {
    barcode,
    found,
    timestamp: timestamp ?? new Date().toISOString(),
    ...(found ? { itemId: 1, catalog: "CAT-1", vendor: "Vendor" } : {}),
  };
}

/** ISO timestamp for N days ago (local midnight is fine for grouping tests). */
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ── prependEntry ──────────────────────────────────────────────────────────────

describe("prependEntry", () => {
  it("prepends a new entry to an empty list", () => {
    const entry = makeEntry("BC-001");
    const result = prependEntry([], entry);
    expect(result).toHaveLength(1);
    expect(result[0]!.barcode).toBe("BC-001");
  });

  it("places the new entry at index 0", () => {
    const existing = [makeEntry("OLD-1"), makeEntry("OLD-2")];
    const newer = makeEntry("NEW");
    const result = prependEntry(existing, newer);
    expect(result[0]!.barcode).toBe("NEW");
    expect(result[1]!.barcode).toBe("OLD-1");
  });

  it("deduplicates: removes an existing entry with the same barcode before prepending", () => {
    const existing = [
      makeEntry("BC-DUPE", true, "2025-01-01T10:00:00.000Z"),
      makeEntry("BC-OTHER"),
    ];
    const updated = makeEntry("BC-DUPE", true, "2025-06-01T10:00:00.000Z");
    const result = prependEntry(existing, updated);
    // Only one entry for BC-DUPE, and it should be the latest one
    const dupeEntries = result.filter((e) => e.barcode === "BC-DUPE");
    expect(dupeEntries).toHaveLength(1);
    expect(dupeEntries[0]!.timestamp).toBe("2025-06-01T10:00:00.000Z");
  });

  it("trims the list to at most 50 entries", () => {
    const existing: ScanEntry[] = Array.from({ length: 50 }, (_, i) =>
      makeEntry(`BC-${i}`),
    );
    const result = prependEntry(existing, makeEntry("BC-NEW"));
    expect(result).toHaveLength(50);
    expect(result[0]!.barcode).toBe("BC-NEW");
  });

  it("does not mutate the existing array", () => {
    const existing = [makeEntry("BC-A"), makeEntry("BC-B")];
    const snapshot = existing.map((e) => e.barcode);
    prependEntry(existing, makeEntry("BC-C"));
    expect(existing.map((e) => e.barcode)).toEqual(snapshot);
  });

  it("works with a not-found entry", () => {
    const entry: ScanEntry = makeEntry("BC-MISS", false);
    const result = prependEntry([], entry);
    expect(result[0]!.found).toBe(false);
  });
});

// ── groupScansByDate ──────────────────────────────────────────────────────────

describe("groupScansByDate", () => {
  it("returns an empty array for empty input", () => {
    expect(groupScansByDate([])).toEqual([]);
  });

  it("labels today's entries as 'Today'", () => {
    const entries = [makeEntry("BC-TODAY", true, daysAgoISO(0))];
    const groups = groupScansByDate(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Today");
    expect(groups[0]!.entries).toHaveLength(1);
  });

  it("labels yesterday's entries as 'Yesterday'", () => {
    const entries = [makeEntry("BC-YEST", true, daysAgoISO(1))];
    const groups = groupScansByDate(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Yesterday");
  });

  it("labels older entries with a month-day string (not Today / Yesterday)", () => {
    const entries = [makeEntry("BC-OLD", true, daysAgoISO(5))];
    const groups = groupScansByDate(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).not.toBe("Today");
    expect(groups[0]!.label).not.toBe("Yesterday");
    // Month name + day number, e.g. "May 15"
    expect(groups[0]!.label).toMatch(/^[A-Z][a-z]{2} \d+$/);
  });

  it("groups multiple entries with the same date into one bucket", () => {
    const ts = daysAgoISO(0);
    const entries = [
      makeEntry("BC-A", true, ts),
      makeEntry("BC-B", true, ts),
      makeEntry("BC-C", true, ts),
    ];
    const groups = groupScansByDate(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(3);
  });

  it("produces one group per distinct date", () => {
    const entries = [
      makeEntry("BC-TODAY", true, daysAgoISO(0)),
      makeEntry("BC-YEST", true, daysAgoISO(1)),
      makeEntry("BC-OLD", true, daysAgoISO(5)),
    ];
    const groups = groupScansByDate(entries);
    expect(groups).toHaveLength(3);
    const labels = groups.map((g) => g.label);
    expect(labels).toContain("Today");
    expect(labels).toContain("Yesterday");
  });

  it("exposes a stable dateKey on each group", () => {
    const entries = [makeEntry("BC-X", true, daysAgoISO(0))];
    const [group] = groupScansByDate(entries) as [ScanGroup];
    // dateKey format: YYYY-MM-DD
    expect(group.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("preserves the order of entries within each group", () => {
    const ts = daysAgoISO(0);
    const entries = [
      makeEntry("FIRST", true, ts),
      makeEntry("SECOND", true, ts),
    ];
    const [group] = groupScansByDate(entries) as [ScanGroup];
    expect(group.entries[0]!.barcode).toBe("FIRST");
    expect(group.entries[1]!.barcode).toBe("SECOND");
  });
});

// ── isValidScanEntry ──────────────────────────────────────────────────────────

describe("isValidScanEntry", () => {
  it("accepts a valid scan, including optional admin audit metadata", () => {
    expect(isValidScanEntry({
      ...makeEntry("BC-VALID"),
      adminAction: "linked",
    })).toBe(true);
  });

  it("rejects missing fields, invalid timestamps, and malformed optional fields", () => {
    expect(isValidScanEntry({ barcode: "BC-MISSING", found: true })).toBe(false);
    expect(isValidScanEntry({ ...makeEntry("BC-BAD-TIME"), timestamp: "not-a-date" })).toBe(false);
    expect(isValidScanEntry({ ...makeEntry("BC-BAD-ID"), itemId: "1" })).toBe(false);
    expect(isValidScanEntry({ ...makeEntry("BC-BAD-ACTION"), adminAction: "deleted" })).toBe(false);
  });
});
