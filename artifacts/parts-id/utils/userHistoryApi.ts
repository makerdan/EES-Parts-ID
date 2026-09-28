import { API_BASE } from "@/utils/apiBase";
import { fetchWithAuth } from "@/utils/appAuth";
import {
  isValidScanEntry,
  MAX_SCAN_HISTORY,
  type ScanEntry,
} from "@/utils/scanHistory";
import {
  isValidViewedEntry,
  MAX_QUERY_HISTORY,
  MAX_VIEWED_HISTORY,
  type ViewedEntry,
} from "@/utils/searchHistory";

export interface UserHistorySnapshot {
  queryHistory: Array<string>;
  viewedHistory: Array<ViewedEntry>;
  scanHistory: Array<ScanEntry>;
}

export type UserHistoryPatch = Partial<UserHistorySnapshot>;

export const EMPTY_USER_HISTORY: UserHistorySnapshot = {
  queryHistory: [],
  viewedHistory: [],
  scanHistory: [],
};

function parseUserHistory(value: unknown): UserHistorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The history response was invalid");
  }
  const history = value as Record<string, unknown>;
  if (
    !Array.isArray(history.queryHistory) ||
    history.queryHistory.length > MAX_QUERY_HISTORY ||
    !history.queryHistory.every((query) => typeof query === "string" && query.trim().length > 0) ||
    !Array.isArray(history.viewedHistory) ||
    history.viewedHistory.length > MAX_VIEWED_HISTORY ||
    !history.viewedHistory.every(isValidViewedEntry) ||
    !Array.isArray(history.scanHistory) ||
    history.scanHistory.length > MAX_SCAN_HISTORY ||
    !history.scanHistory.every(isValidScanEntry)
  ) {
    throw new Error("The history response was invalid");
  }
  return {
    queryHistory: history.queryHistory,
    viewedHistory: history.viewedHistory,
    scanHistory: history.scanHistory,
  };
}

async function sendHistoryRequest(
  method: "GET" | "PATCH",
  token: string,
  patch?: UserHistoryPatch,
  signal?: AbortSignal,
): Promise<UserHistorySnapshot> {
  const response = await fetchWithAuth(
    `${API_BASE}/user/history`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(patch ? { "Content-Type": "application/json" } : {}),
      },
      ...(patch ? { body: JSON.stringify(patch) } : {}),
      ...(signal ? { signal } : {}),
    },
    15_000,
  );
  if (!response.ok) {
    throw new Error(`History request failed (${response.status})`);
  }
  return parseUserHistory(await response.json());
}

export function loadUserHistory(
  token: string,
  signal?: AbortSignal,
): Promise<UserHistorySnapshot> {
  return sendHistoryRequest("GET", token, undefined, signal);
}

export function updateUserHistory(
  patch: UserHistoryPatch,
  token: string,
  signal?: AbortSignal,
): Promise<UserHistorySnapshot> {
  if (Object.keys(patch).length === 0) {
    return Promise.reject(new Error("At least one history collection must be updated"));
  }
  return sendHistoryRequest("PATCH", token, patch, signal);
}