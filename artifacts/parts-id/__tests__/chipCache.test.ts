/**
 * Unit tests for the three-layer chip answer cache (utils/chipCache.ts).
 *
 * fetch is replaced with a jest.fn() before each test so no real network
 * calls are made.  Each helper returns the minimal Response-like shape that
 * the implementation reads (ok, json()).
 */

import { fetchChipAnswer, prefetchQuickLookups, BoundedLruMap, MAX_AGE_MS, MAX_CACHE_SIZE, type CacheEntry } from "../utils/chipCache";

const API_BASE = "https://test.example/api";
const LABEL = "GFCI";
const QUESTION = "What is GFCI?";
const ANSWER = "Ground Fault Circuit Interrupter.";

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function freshEntry(answer: string): CacheEntry {
  return { answer, fetchedAt: Date.now() };
}

let mockFetch: jest.Mock;

beforeEach(() => {
  mockFetch = jest.fn();
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
});

afterEach(() => {
  jest.resetAllMocks();
});

// ── fetchChipAnswer — TTL / expiry ──────────────────────────────────────────

describe("fetchChipAnswer — TTL expiry", () => {
  it("serves a fresh entry (within MAX_AGE_MS) from the in-memory cache without fetching", async () => {
    const cache = new Map<string, CacheEntry>([[LABEL, freshEntry(ANSWER)]]);

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe(ANSWER);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats an entry older than MAX_AGE_MS as a miss and falls through to Layer 2", async () => {
    const staleEntry: CacheEntry = { answer: ANSWER, fetchedAt: Date.now() - MAX_AGE_MS - 1 };
    const cache = new Map<string, CacheEntry>([[LABEL, staleEntry]]);
    mockFetch.mockResolvedValueOnce(makeResponse(200, { answer: "fresh answer" }));

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe("fresh answer");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("removes a stale entry from the cache before re-fetching", async () => {
    const staleEntry: CacheEntry = { answer: ANSWER, fetchedAt: Date.now() - MAX_AGE_MS - 1 };
    const cache = new Map<string, CacheEntry>([[LABEL, staleEntry]]);
    mockFetch.mockResolvedValueOnce(makeResponse(200, { answer: "fresh answer" }));

    await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(cache.get(LABEL)?.answer).toBe("fresh answer");
  });
});

// ── fetchChipAnswer — Layer 1 (in-memory cache) ────────────────────────────────

describe("fetchChipAnswer — Layer 1 (in-memory cache)", () => {
  it("returns the cached value immediately without calling fetch", async () => {
    const cache = new Map<string, CacheEntry>([[LABEL, freshEntry(ANSWER)]]);
    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);
    expect(result).toBe(ANSWER);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats an empty-string cache entry as cached (no network call)", async () => {
    const cache = new Map<string, CacheEntry>([[LABEL, freshEntry("")]]);
    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);
    expect(result).toBe("");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fetchChipAnswer — Layer 2 (DB cache via GET)", () => {
  it("returns the DB answer on a 200 GET and stores it in the cache", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch.mockResolvedValueOnce(makeResponse(200, { answer: ANSWER }));

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe(ANSWER);
    expect(cache.get(LABEL)?.answer).toBe(ANSWER);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain(`quick-lookups/${encodeURIComponent(LABEL)}`);
    expect((mockFetch.mock.calls[0][1] as RequestInit | undefined)?.method).toBeUndefined();
  });

  it("does NOT call the AI (POST) when GET returns 200", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch.mockResolvedValueOnce(makeResponse(200, { answer: ANSWER }));

    await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    const methods = mockFetch.mock.calls.map((c: unknown[]) =>
      (c[1] as { method?: string } | undefined)?.method ?? "GET",
    );
    expect(methods).not.toContain("POST");
  });
});

describe("fetchChipAnswer — Layer 3 (AI fallback via POST)", () => {
  it("falls through to POST when GET returns 404 and caches the result", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch
      .mockResolvedValueOnce(makeResponse(404, {}))
      .mockResolvedValueOnce(makeResponse(200, { answer: ANSWER }));

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe(ANSWER);
    expect(cache.get(LABEL)?.answer).toBe(ANSWER);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, postCall] = mockFetch.mock.calls as [unknown[], [string, RequestInit]];
    expect(postCall[1].method).toBe("POST");
    expect(JSON.parse(postCall[1].body as string)).toEqual({ question: QUESTION });
  });

  it("falls through to POST when GET throws a network error", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(makeResponse(200, { answer: ANSWER }));

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe(ANSWER);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when the POST (AI fallback) returns a non-OK status", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch
      .mockResolvedValueOnce(makeResponse(404, {}))
      .mockResolvedValueOnce(makeResponse(500, {}));

    await expect(fetchChipAnswer(LABEL, QUESTION, cache, API_BASE)).rejects.toThrow(
      "AI fallback failed",
    );
    expect(cache.has(LABEL)).toBe(false);
  });
});

// ── prefetchQuickLookups ───────────────────────────────────────────────────────

describe("prefetchQuickLookups", () => {
  it("populates the cache from the list endpoint", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, [
        { label: "GFCI", answer: "Ground fault interrupter." },
        { label: "AWG", answer: "American Wire Gauge." },
      ]),
    );

    await prefetchQuickLookups(cache, API_BASE);

    expect(cache.get("GFCI")?.answer).toBe("Ground fault interrupter.");
    expect(cache.get("AWG")?.answer).toBe("American Wire Gauge.");
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/reference/quick-lookups`);
  });

  it("stores a fetchedAt timestamp within each prefetched entry", async () => {
    const before = Date.now();
    const cache = new Map<string, CacheEntry>();
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, [{ label: LABEL, answer: ANSWER }]),
    );

    await prefetchQuickLookups(cache, API_BASE);

    const entry = cache.get(LABEL);
    expect(entry).toBeDefined();
    expect(entry!.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.fetchedAt).toBeLessThanOrEqual(Date.now());
  });

  it("after prefetch, fetchChipAnswer is a Layer-1 hit and makes no further fetch calls", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, [{ label: LABEL, answer: ANSWER }]),
    );

    await prefetchQuickLookups(cache, API_BASE);
    mockFetch.mockClear();

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);
    expect(result).toBe(ANSWER);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ignores a non-OK response from the list endpoint without throwing", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch.mockResolvedValueOnce(makeResponse(503, {}));

    await expect(prefetchQuickLookups(cache, API_BASE)).resolves.toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("ignores a fetch error from the list endpoint without throwing", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch.mockRejectedValueOnce(new Error("offline"));

    await expect(prefetchQuickLookups(cache, API_BASE)).resolves.toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("after MAX_AGE_MS elapses a prefetched entry is treated as stale and falls through to Layer 2", async () => {
    const cache = new Map<string, CacheEntry>();
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, [{ label: LABEL, answer: ANSWER }]),
    );

    await prefetchQuickLookups(cache, API_BASE);
    mockFetch.mockClear();

    // Freeze time past the TTL so the prefetched entry is expired.
    const frozenNow = Date.now() + MAX_AGE_MS + 1;
    jest.spyOn(Date, "now").mockReturnValue(frozenNow);

    mockFetch.mockResolvedValueOnce(makeResponse(200, { answer: "refreshed answer" }));

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe("refreshed answer");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
  });
});

// ── BoundedLruMap ─────────────────────────────────────────────────────────────

describe("BoundedLruMap", () => {
  it("does not evict any entry while size is below maxSize", () => {
    const map = new BoundedLruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(map.size).toBe(3);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
  });

  it("evicts exactly one entry when maxSize is reached", () => {
    const map = new BoundedLruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4); // triggers eviction

    expect(map.size).toBe(3);
  });

  it("evicts the least-recently-used (first-inserted, never accessed) key", () => {
    const map = new BoundedLruMap<string, number>(3);
    map.set("a", 1); // LRU candidate
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4); // evicts "a"

    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
    expect(map.has("d")).toBe(true);
  });

  it("re-setting an existing key moves it to the tail so it is no longer the LRU candidate", () => {
    const map = new BoundedLruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    // Re-set "a" — it should move to the tail; "b" becomes the new LRU
    map.set("a", 99);
    map.set("d", 4); // should evict "b", not "a"

    expect(map.has("b")).toBe(false);
    expect(map.has("a")).toBe(true);
    expect(map.get("a")).toBe(99);
    expect(map.has("c")).toBe(true);
    expect(map.has("d")).toBe(true);
  });

  it("does not corrupt surviving entries after eviction", () => {
    const map = new BoundedLruMap<string, string>(3);
    map.set("x", "val-x");
    map.set("y", "val-y");
    map.set("z", "val-z");
    map.set("w", "val-w"); // evicts "x"

    expect(map.get("y")).toBe("val-y");
    expect(map.get("z")).toBe("val-z");
    expect(map.get("w")).toBe("val-w");
  });

  it("evicts one entry per insertion beyond maxSize (no runaway eviction)", () => {
    const maxSize = 3;
    const map = new BoundedLruMap<number, number>(maxSize);
    for (let i = 0; i < maxSize + 5; i++) {
      map.set(i, i);
      expect(map.size).toBe(Math.min(i + 1, maxSize));
    }
  });

  it("respects MAX_CACHE_SIZE as the default maxSize", () => {
    const map = new BoundedLruMap<number, number>();
    for (let i = 0; i < MAX_CACHE_SIZE; i++) {
      map.set(i, i);
    }
    expect(map.size).toBe(MAX_CACHE_SIZE);

    map.set(MAX_CACHE_SIZE, MAX_CACHE_SIZE); // one over the cap
    expect(map.size).toBe(MAX_CACHE_SIZE);
    expect(map.has(0)).toBe(false); // key 0 was LRU
    expect(map.has(MAX_CACHE_SIZE)).toBe(true);
  });
});
