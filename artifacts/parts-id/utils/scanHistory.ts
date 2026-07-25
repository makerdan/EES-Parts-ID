import AsyncStorage from "@react-native-async-storage/async-storage";

import { reportStorageError } from "@/utils/storageErrorReporter";

const STORAGE_KEY = "@partsid/barcode_scan_history";
const MAX_ENTRIES = 50;

export interface ScanEntry {
  barcode: string;
  found: boolean;
  /** Present when the barcode matched a catalog item */
  itemId?: number;
  catalog?: string;
  vendor?: string;
  /** ISO 8601 string — stored as string so JSON round-trips cleanly */
  timestamp: string;
  /**
   * Set when an admin linked or created a part from the "not found" scanner
   * panel. Undefined for ordinary scans.
   */
  adminAction?: "linked" | "created";
}

function isValidEntry(e: unknown): e is ScanEntry {
  if (!e || typeof e !== "object") return false;
  const obj = e as Record<string, unknown>;
  return (
    typeof obj["barcode"] === "string" &&
    typeof obj["found"] === "boolean" &&
    typeof obj["timestamp"] === "string" &&
    !isNaN(new Date(obj["timestamp"] as string).getTime())
  );
}

export async function loadScanHistory(): Promise<Array<ScanEntry>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

export async function saveScanHistory(entries: Array<ScanEntry>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (err) {
    reportStorageError("Could not save scan history", err);
  }
}

/**
 * Prepend a new entry, deduplicating by barcode so the latest scan bubbles to
 * the top. Admin-action entries ("linked" / "created") are permanent audit
 * records and are never evicted during dedup — only non-admin entries for the
 * same barcode are removed. Trims to MAX_ENTRIES.
 */
export function prependEntry(
  existing: Array<ScanEntry>,
  entry: ScanEntry,
): Array<ScanEntry> {
  const deduped = existing.filter(
    (e) => e.barcode !== entry.barcode || !!e.adminAction,
  );
  return [entry, ...deduped].slice(0, MAX_ENTRIES);
}

export async function clearScanHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    reportStorageError("Could not clear scan history", err);
  }
}

// ── Date-grouped history ───────────────────────────────────────────────────────

export interface ScanGroup {
  /** Human-readable label: "Today", "Yesterday", or e.g. "May 14" */
  label: string;
  /** YYYY-MM-DD key used as a stable collapse identifier */
  dateKey: string;
  entries: Array<ScanEntry>;
}

function toLocalDateKey(isoString: string): string {
  const d = new Date(isoString);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function labelForDateKey(dateKey: string, todayKey: string, yesterdayKey: string): string {
  if (dateKey === todayKey) return "Today";
  if (dateKey === yesterdayKey) return "Yesterday";
  const [, m = "", d = ""] = dateKey.split("-");
  const month = MONTH_NAMES[parseInt(m, 10) - 1] ?? m;
  return `${month} ${parseInt(d, 10)}`;
}

/**
 * Groups a flat list of ScanEntry (assumed newest-first) into date buckets.
 * Groups are ordered newest-first. Entries within each group preserve their
 * original order.
 */
export function groupScansByDate(entries: Array<ScanEntry>): Array<ScanGroup> {
  const now = new Date();
  const todayKey = toLocalDateKey(now.toISOString());
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = toLocalDateKey(yesterday.toISOString());

  const map = new Map<string, Array<ScanEntry>>();
  for (const entry of entries) {
    const key = toLocalDateKey(entry.timestamp);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      map.set(key, [entry]);
    }
  }

  return Array.from(map.entries()).map(([dateKey, groupEntries]) => ({
    label: labelForDateKey(dateKey, todayKey, yesterdayKey),
    dateKey,
    entries: groupEntries,
  }));
}
