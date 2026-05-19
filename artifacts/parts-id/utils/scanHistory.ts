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
}

export async function loadScanHistory(): Promise<ScanEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ScanEntry[];
  } catch {
    return [];
  }
}

export async function saveScanHistory(entries: ScanEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (err) {
    reportStorageError("Could not save scan history", err);
  }
}

/**
 * Prepend a new entry, deduplicating by barcode (existing entry is removed
 * before prepending so the latest scan bubbles to the top). Trims to MAX_ENTRIES.
 */
export function prependEntry(
  existing: ScanEntry[],
  entry: ScanEntry,
): ScanEntry[] {
  const deduped = existing.filter((e) => e.barcode !== entry.barcode);
  return [entry, ...deduped].slice(0, MAX_ENTRIES);
}

export async function clearScanHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    reportStorageError("Could not clear scan history", err);
  }
}
