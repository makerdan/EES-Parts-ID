export const MAX_QUERY_HISTORY = 10;
export const MAX_VIEWED_HISTORY = 10;

export interface ViewedEntry {
  id: number;
  catalog: string;
  name: string;
  vendor: string;
  timestamp: string;
}

export function isValidViewedEntry(value: unknown): value is ViewedEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "number" &&
    Number.isSafeInteger(entry.id) &&
    entry.id > 0 &&
    typeof entry.catalog === "string" &&
    typeof entry.name === "string" &&
    typeof entry.vendor === "string" &&
    typeof entry.timestamp === "string" &&
    Number.isFinite(Date.parse(entry.timestamp))
  );
}

export function prependQueryHistory(current: Array<string>, query: string): Array<string> {
  const trimmed = query.trim();
  if (!trimmed) return current;
  return [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(0, MAX_QUERY_HISTORY);
}

export function prependViewedHistory(
  current: Array<ViewedEntry>,
  entry: Omit<ViewedEntry, "timestamp">,
): Array<ViewedEntry> {
  return [
    { ...entry, timestamp: new Date().toISOString() },
    ...current.filter((existing) => existing.id !== entry.id),
  ].slice(0, MAX_VIEWED_HISTORY);
}