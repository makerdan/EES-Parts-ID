/**
 * @jest-environment node
 *
 * Integration-level tests for the logout storage-clearing contract.
 *
 * The logout flow has two components tested here:
 *   A) clearSessionStorage — the pure helper that deletes the session and
 *      admin-token keys from SecureStore and removes search-cache keys from
 *      AsyncStorage.  This is the authoritative source of truth for which
 *      storage keys are wiped.
 *
 *   B) LogoutRegistry integration — verifies that all handlers registered
 *      before logout.fire() execute, and that unsubscribed handlers do NOT
 *      execute, mirroring the pattern used by AppContext and SearchScreen.
 *
 * Covered scenarios
 * ─────────────────
 * clearSessionStorage
 *   1. Calls secureDelete for SESSION_KEY
 *   2. Calls secureDelete for ADMIN_TOKEN_KEY
 *   3. Calls multiRemove with the exact SEARCH_CACHE_KEYS array
 *   4. SEARCH_CACHE_KEYS includes the Fuse cache key
 *   5. SEARCH_CACHE_KEYS includes the query cache key
 *   6. After clearSessionStorage, reads from the mocked store return null
 *   7. secureDelete failure is propagated (caller handles errors)
 *   8. multiRemove failure is propagated
 *
 * LogoutRegistry + clearSessionStorage integration
 *   9.  Storage cleared AND all registered handlers fire on a single logout
 *  10.  Handler registered AFTER fire() is NOT called retroactively
 *  11.  Unsubscribed handler does NOT fire during logout
 *  12.  Partial failure (one handler throws) does not prevent storage clearing
 */

import {
  clearSessionStorage,
  SESSION_KEY,
  ADMIN_TOKEN_KEY,
  SEARCH_CACHE_KEYS,
} from "../utils/sessionStorage";
import { LogoutRegistry } from "../utils/logoutRegistry";

// ── clearSessionStorage ───────────────────────────────────────────────────────

describe("clearSessionStorage", () => {
  it("calls secureDelete with SESSION_KEY", async () => {
    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const multiRemove  = jest.fn().mockResolvedValue(undefined);
    await clearSessionStorage(secureDelete, multiRemove);
    expect(secureDelete).toHaveBeenCalledWith(SESSION_KEY);
  });

  it("calls secureDelete with ADMIN_TOKEN_KEY", async () => {
    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const multiRemove  = jest.fn().mockResolvedValue(undefined);
    await clearSessionStorage(secureDelete, multiRemove);
    expect(secureDelete).toHaveBeenCalledWith(ADMIN_TOKEN_KEY);
  });

  it("calls multiRemove with the exact SEARCH_CACHE_KEYS array", async () => {
    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const multiRemove  = jest.fn().mockResolvedValue(undefined);
    await clearSessionStorage(secureDelete, multiRemove);
    expect(multiRemove).toHaveBeenCalledTimes(1);
    expect(multiRemove).toHaveBeenCalledWith(SEARCH_CACHE_KEYS);
  });

  it("SEARCH_CACHE_KEYS includes the Fuse offline-barcode/search cache key", () => {
    const fuseKey = "parts_id_fuse_cache_v2";
    expect(SEARCH_CACHE_KEYS).toContain(fuseKey);
  });

  it("SEARCH_CACHE_KEYS includes the query-result cache key", () => {
    const queryCacheKey = "parts_id_query_cache_v1";
    expect(SEARCH_CACHE_KEYS).toContain(queryCacheKey);
  });

  it("after clearing, mocked store reads return null for session keys", async () => {
    const store: Record<string, string | null> = {
      [SESSION_KEY]: "authenticated",
      [ADMIN_TOKEN_KEY]: "admin-jwt-token",
    };
    const secureDelete = jest.fn(async (key: string) => { store[key] = null; });
    const multiRemove  = jest.fn().mockResolvedValue(undefined);

    await clearSessionStorage(secureDelete, multiRemove);

    expect(store[SESSION_KEY]).toBeNull();
    expect(store[ADMIN_TOKEN_KEY]).toBeNull();
  });

  it("after clearing, mocked AsyncStorage returns null for search-cache keys", async () => {
    const asyncStore: Record<string, string | null> = {
      "parts_id_fuse_cache_v2":  JSON.stringify([{ id: 1 }]),
      "parts_id_query_cache_v1": JSON.stringify({ key: { results: [] } }),
    };
    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const multiRemove  = jest.fn(async (keys: string[]) => {
      for (const k of keys) asyncStore[k] = null;
    });

    await clearSessionStorage(secureDelete, multiRemove);

    for (const key of SEARCH_CACHE_KEYS) {
      expect(asyncStore[key]).toBeNull();
    }
  });

  it("propagates secureDelete failures to the caller", async () => {
    const secureDelete = jest.fn().mockRejectedValue(new Error("SecureStore unavailable"));
    const multiRemove  = jest.fn().mockResolvedValue(undefined);
    await expect(clearSessionStorage(secureDelete, multiRemove)).rejects.toThrow("SecureStore unavailable");
  });

  it("propagates multiRemove failures to the caller", async () => {
    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const multiRemove  = jest.fn().mockRejectedValue(new Error("AsyncStorage write error"));
    await expect(clearSessionStorage(secureDelete, multiRemove)).rejects.toThrow("AsyncStorage write error");
  });
});

// ── LogoutRegistry + clearSessionStorage integration ─────────────────────────

describe("LogoutRegistry + clearSessionStorage integration", () => {
  it("storage cleared AND all registered handlers fire on a single logout", async () => {
    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const multiRemove  = jest.fn().mockResolvedValue(undefined);
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    const reg = new LogoutRegistry();
    reg.register(handlerA);
    reg.register(handlerB);

    // Simulate AppContext logout: clear storage then fire registry
    await clearSessionStorage(secureDelete, multiRemove);
    reg.fire();

    expect(secureDelete).toHaveBeenCalledWith(SESSION_KEY);
    expect(multiRemove).toHaveBeenCalledWith(SEARCH_CACHE_KEYS);
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it("handler registered after fire() is NOT called retroactively", async () => {
    const reg = new LogoutRegistry();
    const earlyHandler = jest.fn();
    reg.register(earlyHandler);
    reg.fire();

    const lateHandler = jest.fn();
    reg.register(lateHandler);

    expect(earlyHandler).toHaveBeenCalledTimes(1);
    expect(lateHandler).not.toHaveBeenCalled();
  });

  it("unsubscribed handler does NOT fire during logout", async () => {
    const reg = new LogoutRegistry();
    const handler = jest.fn();
    const unsubscribe = reg.register(handler);
    unsubscribe(); // remove before logout

    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const multiRemove  = jest.fn().mockResolvedValue(undefined);
    await clearSessionStorage(secureDelete, multiRemove);
    reg.fire();

    expect(handler).not.toHaveBeenCalled();
    // Storage must still be cleared even when no handlers are registered
    expect(secureDelete).toHaveBeenCalledWith(SESSION_KEY);
  });

  it("partial handler failure does not prevent storage clearing from completing", async () => {
    const reg = new LogoutRegistry();
    reg.register(() => { throw new Error("screen cleanup failed"); });

    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const multiRemove  = jest.fn().mockResolvedValue(undefined);

    // Storage clearing happens before fire() — should always succeed
    await clearSessionStorage(secureDelete, multiRemove);
    expect(() => reg.fire()).not.toThrow();

    expect(secureDelete).toHaveBeenCalledTimes(2); // SESSION_KEY + ADMIN_TOKEN_KEY
    expect(multiRemove).toHaveBeenCalledTimes(1);
  });
});
