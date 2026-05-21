/**
 * Unit tests for the three-layer chip answer cache (utils/chipCache.ts).
 *
 * fetch is replaced with a jest.fn() before each test so no real network
 * calls are made.  Each helper returns the minimal Response-like shape that
 * the implementation reads (ok, json()).
 */

import { fetchChipAnswer, prefetchQuickLookups } from "../utils/chipCache";

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

let mockFetch: jest.Mock;

beforeEach(() => {
  mockFetch = jest.fn();
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
});

afterEach(() => {
  jest.resetAllMocks();
});

// ── fetchChipAnswer ────────────────────────────────────────────────────────────

describe("fetchChipAnswer — Layer 1 (in-memory cache)", () => {
  it("returns the cached value immediately without calling fetch", async () => {
    const cache = new Map([[LABEL, ANSWER]]);
    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);
    expect(result).toBe(ANSWER);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats an empty-string cache entry as cached (no network call)", async () => {
    const cache = new Map([[LABEL, ""]]);
    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);
    expect(result).toBe("");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fetchChipAnswer — Layer 2 (DB cache via GET)", () => {
  it("returns the DB answer on a 200 GET and stores it in the cache", async () => {
    const cache = new Map<string, string>();
    mockFetch.mockResolvedValueOnce(makeResponse(200, { answer: ANSWER }));

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe(ANSWER);
    expect(cache.get(LABEL)).toBe(ANSWER);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain(`quick-lookups/${encodeURIComponent(LABEL)}`);
    expect(mockFetch.mock.calls[0][1]).toBeUndefined();
  });

  it("does NOT call the AI (POST) when GET returns 200", async () => {
    const cache = new Map<string, string>();
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
    const cache = new Map<string, string>();
    mockFetch
      .mockResolvedValueOnce(makeResponse(404, {}))
      .mockResolvedValueOnce(makeResponse(200, { answer: ANSWER }));

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe(ANSWER);
    expect(cache.get(LABEL)).toBe(ANSWER);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, postCall] = mockFetch.mock.calls as [unknown[], [string, RequestInit]];
    expect(postCall[1].method).toBe("POST");
    expect(JSON.parse(postCall[1].body as string)).toEqual({ question: QUESTION });
  });

  it("falls through to POST when GET throws a network error", async () => {
    const cache = new Map<string, string>();
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(makeResponse(200, { answer: ANSWER }));

    const result = await fetchChipAnswer(LABEL, QUESTION, cache, API_BASE);

    expect(result).toBe(ANSWER);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when the POST (AI fallback) returns a non-OK status", async () => {
    const cache = new Map<string, string>();
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
    const cache = new Map<string, string>();
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, [
        { label: "GFCI", answer: "Ground fault interrupter." },
        { label: "AWG", answer: "American Wire Gauge." },
      ]),
    );

    await prefetchQuickLookups(cache, API_BASE);

    expect(cache.get("GFCI")).toBe("Ground fault interrupter.");
    expect(cache.get("AWG")).toBe("American Wire Gauge.");
    expect(mockFetch).toHaveBeenCalledWith(`${API_BASE}/reference/quick-lookups`);
  });

  it("after prefetch, fetchChipAnswer is a Layer-1 hit and makes no further fetch calls", async () => {
    const cache = new Map<string, string>();
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
    const cache = new Map<string, string>();
    mockFetch.mockResolvedValueOnce(makeResponse(503, {}));

    await expect(prefetchQuickLookups(cache, API_BASE)).resolves.toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("ignores a fetch error from the list endpoint without throwing", async () => {
    const cache = new Map<string, string>();
    mockFetch.mockRejectedValueOnce(new Error("offline"));

    await expect(prefetchQuickLookups(cache, API_BASE)).resolves.toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
