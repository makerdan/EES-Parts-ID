/**
 * @jest-environment node
 *
 * Unit tests for the scan-history utilities.
 * Covers:
 *   - prependEntry: prepend, deduplication, MAX_ENTRIES cap
 *   - groupScansByDate: "Today" / "Yesterday" / named-month labels, ordering,
 *     multiple entries in a single group, empty input
 *   - loadScanHistory: storage hit, empty storage, corrupt JSON, non-array JSON,
 *     entries with invalid shapes are filtered, AsyncStorage error
 *   - saveScanHistory: delegates to AsyncStorage correctly
 */

import {
  prependEntry,
  groupScansByDate,
  loadScanHistory,
  saveScanHistory,
} from "../utils/scanHistory";
import type { ScanEntry, ScanGroup } from "../utils/scanHistory";

// ── AsyncStorage mock ─────────────────────────────────────────────────────────
const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
    removeItem: jest.fn(() => Promise.resolve()),
    multiRemove: jest.fn(() => Promise.resolve()),
  },
}));

// storageErrorReporter is called on saveScanHistory failures; silence it
jest.mock("../utils/storageErrorReporter", () => ({
  reportStorageError: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSetItem.mockResolvedValue(undefined);
});

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

// ── loadScanHistory ───────────────────────────────────────────────────────────

describe("loadScanHistory", () => {
  it("returns an empty array when AsyncStorage has no entry", async () => {
    mockGetItem.mockResolvedValue(null);
    expect(await loadScanHistory()).toEqual([]);
  });

  it("returns parsed entries when the storage key is populated", async () => {
    const entries: ScanEntry[] = [
      makeEntry("BC-1"),
      makeEntry("BC-2", false),
    ];
    mockGetItem.mockResolvedValue(JSON.stringify(entries));
    const result = await loadScanHistory();
    expect(result).toHaveLength(2);
    expect(result[0]!.barcode).toBe("BC-1");
  });

  it("returns an empty array for corrupt JSON", async () => {
    mockGetItem.mockResolvedValue("{{{not-json");
    expect(await loadScanHistory()).toEqual([]);
  });

  it("returns an empty array when the stored value is not an array", async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({ barcode: "X" }));
    expect(await loadScanHistory()).toEqual([]);
  });

  it("filters out entries that are missing required fields", async () => {
    const good: ScanEntry = makeEntry("GOOD");
    const bad = { barcode: 123, found: "yes" }; // wrong types
    const noTimestamp = { barcode: "BC-NT", found: true }; // missing timestamp
    mockGetItem.mockResolvedValue(JSON.stringify([good, bad, noTimestamp]));
    const result = await loadScanHistory();
    expect(result).toHaveLength(1);
    expect(result[0]!.barcode).toBe("GOOD");
  });

  it("returns an empty array when AsyncStorage throws", async () => {
    mockGetItem.mockRejectedValue(new Error("permission denied"));
    expect(await loadScanHistory()).toEqual([]);
  });
});

// ── saveScanHistory ───────────────────────────────────────────────────────────

describe("saveScanHistory", () => {
  it("serialises entries to AsyncStorage with the correct key", async () => {
    const entries: ScanEntry[] = [makeEntry("BC-SAVE")];
    await saveScanHistory(entries);
    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [key, raw] = mockSetItem.mock.calls[0] as [string, string];
    expect(key).toBe("@partsid/barcode_scan_history");
    const parsed = JSON.parse(raw) as ScanEntry[];
    expect(parsed[0]!.barcode).toBe("BC-SAVE");
  });

  it("serialises an empty array without error", async () => {
    await saveScanHistory([]);
    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [, raw] = mockSetItem.mock.calls[0] as [string, string];
    expect(JSON.parse(raw)).toEqual([]);
  });
});
