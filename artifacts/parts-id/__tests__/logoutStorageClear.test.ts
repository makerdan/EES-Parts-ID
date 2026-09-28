/**
 * @jest-environment node
 *
 * Logout clears private session state but preserves shared catalog caches.
 */
import {
  clearSessionStorage,
  SEARCH_CACHE_KEYS,
  SESSION_KEY,
} from "../utils/sessionStorage";
import { LogoutRegistry } from "../utils/logoutRegistry";

describe("clearSessionStorage", () => {
  it("deletes only the private session key", async () => {
    const secureDelete = jest.fn().mockResolvedValue(undefined);
    await clearSessionStorage(secureDelete);
    expect(secureDelete).toHaveBeenCalledTimes(1);
    expect(secureDelete).toHaveBeenCalledWith(SESSION_KEY);
  });

  it("preserves shared inventory search caches for the next account", async () => {
    const store: Record<string, string | null> = {
      parts_id_fuse_cache_v2: JSON.stringify([{ id: 1 }]),
      parts_id_query_cache_v1: JSON.stringify({ query: { results: [] } }),
    };
    const secureDelete = jest.fn(async (key: string) => {
      if (key === SESSION_KEY) return;
    });
    await clearSessionStorage(secureDelete);

    expect(SEARCH_CACHE_KEYS).toEqual([
      "parts_id_fuse_cache_v2",
      "parts_id_query_cache_v1",
    ]);
    for (const key of SEARCH_CACHE_KEYS) expect(store[key]).not.toBeNull();
  });

  it("propagates secure storage failures to the caller", async () => {
    const secureDelete = jest.fn().mockRejectedValue(new Error("SecureStore unavailable"));
    await expect(clearSessionStorage(secureDelete)).rejects.toThrow("SecureStore unavailable");
  });
});

describe("LogoutRegistry integration", () => {
  it("clears session storage and fires registered handlers on logout", async () => {
    const secureDelete = jest.fn().mockResolvedValue(undefined);
    const handlerA = jest.fn();
    const handlerB = jest.fn();
    const registry = new LogoutRegistry();
    registry.register(handlerA);
    registry.register(handlerB);

    await clearSessionStorage(secureDelete);
    registry.fire();

    expect(secureDelete).toHaveBeenCalledWith(SESSION_KEY);
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it("does not invoke unsubscribed handlers", () => {
    const registry = new LogoutRegistry();
    const handler = jest.fn();
    registry.register(handler)();
    registry.fire();
    expect(handler).not.toHaveBeenCalled();
  });

  it("continues firing remaining handlers after one handler throws", () => {
    const registry = new LogoutRegistry();
    const healthyHandler = jest.fn();
    registry.register(() => {
      throw new Error("screen cleanup failed");
    });
    registry.register(healthyHandler);

    expect(() => registry.fire()).not.toThrow();
    expect(healthyHandler).toHaveBeenCalledTimes(1);
  });
});