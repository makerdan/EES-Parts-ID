/**
 * Pure session-storage constants and helpers extracted from AppContext so they
 * can be imported in `testEnvironment: "node"` tests without pulling in React
 * or Expo modules.
 */

export const SEARCH_CACHE_KEYS = ["parts_id_fuse_cache_v2", "parts_id_query_cache_v1"];

export const LEGACY_USER_HISTORY_KEYS = [
  "@partsid/query_history_v1",
  "@partsid/viewed_history_v1",
  "@partsid/barcode_scan_history",
];

export const SESSION_KEY       = "parts_id_session";

export async function discardLegacyUserHistoryStorage(
  multiRemoveFn: (keys: Array<string>) => Promise<void>,
): Promise<void> {
  await multiRemoveFn(LEGACY_USER_HISTORY_KEYS);
}

/**
 * Delete only the private session key. Search results and inventory caches
 * contain shared catalog data and remain available when another account signs
 * in on the same device.
 */
export async function clearSessionStorage(
  secureDeleteFn: (key: string) => Promise<void>,
): Promise<void> {
  await secureDeleteFn(SESSION_KEY);
}
