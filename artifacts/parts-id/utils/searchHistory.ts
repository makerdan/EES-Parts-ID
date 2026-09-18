import AsyncStorage from "@react-native-async-storage/async-storage";

import { reportStorageError } from "@/utils/storageErrorReporter";

const QUERY_HISTORY_KEY = "@partsid/query_history_v1";
const VIEWED_HISTORY_KEY = "@partsid/viewed_history_v1";
const MAX_ENTRIES = 10;

export interface ViewedEntry {
  id: number;
  catalog: string;
  name: string;
  vendor: string;
  timestamp: string;
}

let _queryHistoryLock: Promise<void> = Promise.resolve();
let _viewedHistoryLock: Promise<void> = Promise.resolve();

function isValidQueryEntry(e: unknown): e is string {
  return typeof e === "string" && e.trim().length > 0;
}

function isValidViewedEntry(e: unknown): e is ViewedEntry {
  if (!e || typeof e !== "object") return false;
  const obj = e as Record<string, unknown>;
  return (
    typeof obj["id"] === "number" &&
    typeof obj["catalog"] === "string" &&
    typeof obj["name"] === "string" &&
    typeof obj["vendor"] === "string" &&
    typeof obj["timestamp"] === "string" &&
    !isNaN(new Date(obj["timestamp"] as string).getTime())
  );
}

export async function loadQueryHistory(): Promise<Array<string>> {
  try {
    const raw = await AsyncStorage.getItem(QUERY_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidQueryEntry);
  } catch {
    return [];
  }
}

export async function appendQueryHistory(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;
  const next = _queryHistoryLock.then(async () => {
    const current = await loadQueryHistory();
    const deduped = current.filter(q => q !== trimmed);
    const updated = [trimmed, ...deduped].slice(0, MAX_ENTRIES);
    try {
      await AsyncStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(updated));
    } catch (err) {
      reportStorageError("Could not save query history", err);
    }
  });
  _queryHistoryLock = next.catch(() => {});
  return next;
}

export async function clearQueryHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(QUERY_HISTORY_KEY);
  } catch (err) {
    reportStorageError("Could not clear query history", err);
  }
}

export async function loadViewedHistory(): Promise<Array<ViewedEntry>> {
  try {
    const raw = await AsyncStorage.getItem(VIEWED_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidViewedEntry);
  } catch {
    return [];
  }
}

export async function appendViewedHistory(
  entry: Omit<ViewedEntry, "timestamp">,
): Promise<void> {
  const next = _viewedHistoryLock.then(async () => {
    const current = await loadViewedHistory();
    const deduped = current.filter(e => e.id !== entry.id);
    const updated: Array<ViewedEntry> = [
      { ...entry, timestamp: new Date().toISOString() },
      ...deduped,
    ].slice(0, MAX_ENTRIES);
    try {
      await AsyncStorage.setItem(VIEWED_HISTORY_KEY, JSON.stringify(updated));
    } catch (err) {
      reportStorageError("Could not save viewed history", err);
    }
  });
  _viewedHistoryLock = next.catch(() => {});
  return next;
}

export async function clearViewedHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(VIEWED_HISTORY_KEY);
  } catch (err) {
    reportStorageError("Could not clear viewed history", err);
  }
}
