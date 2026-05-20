/**
 * Pure session-storage constants and helpers extracted from AppContext so they
 * can be imported in `testEnvironment: "node"` tests without pulling in React
 * or Expo modules.
 */

export const SEARCH_CACHE_KEYS = ["parts_id_fuse_cache_v2", "parts_id_query_cache_v1"];

export const SESSION_KEY       = "parts_id_session";
export const ADMIN_TOKEN_KEY   = "parts_id_admin_token";

/**
 * Delete all session and search-cache storage entries that belong to a logged-
 * in session.  Extracted here so the logout flow can be unit-tested without a
 * React component tree.
 *
 * @param secureDeleteFn  Removes a key from the secure key-value store
 *                        (expo-secure-store in production).
 * @param multiRemoveFn   Removes multiple keys from AsyncStorage.
 */
export async function clearSessionStorage(
  secureDeleteFn: (key: string) => Promise<void>,
  multiRemoveFn:  (keys: string[]) => Promise<void>,
): Promise<void> {
  await secureDeleteFn(SESSION_KEY);
  await secureDeleteFn(ADMIN_TOKEN_KEY);
  await multiRemoveFn(SEARCH_CACHE_KEYS);
}
