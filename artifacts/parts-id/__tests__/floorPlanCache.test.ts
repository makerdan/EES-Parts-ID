/**
 * @jest-environment node
 *
 * Unit tests for utils/floorPlanCache.ts
 *
 * Covers:
 *   - initPersistRead: cache miss, cache hit (matching hash), cache hit (stale
 *     hash), malformed / corrupted stored data, promise deduplication
 *   - getIfValid: returns data on hash match, null on hash mismatch
 *   - getCachedData: returns data regardless of hash
 *   - hasCachedData: reflects cache presence
 *   - setCached: updates memory and calls AsyncStorage.setItem
 *   - setFallbackEmpty: sets empty entry in memory only, no storage write,
 *     does not overwrite valid cached data
 */

import {
  initPersistRead,
  getCachedData,
  getIfValid,
  hasCachedData,
  setCached,
  setFallbackEmpty,
  _resetForTests,
  STORAGE_KEY,
  type SvgData,
} from "../utils/floorPlanCache";

// ── AsyncStorage mock ─────────────────────────────────────────────────────────
const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
  },
}));

// ── Test data ─────────────────────────────────────────────────────────────────
const HASH = "abc123def456";
const SVG_DATA: SvgData = {
  xml: "<svg><g/></svg>",
  innerXml: "<g/>",
  uri: "file:///var/containers/warehouse-map.svg",
};
const stored = JSON.stringify({ hash: HASH, ...SVG_DATA });

// ── Reset between tests ───────────────────────────────────────────────────────
beforeEach(() => {
  _resetForTests();
  jest.clearAllMocks();
  mockSetItem.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("initPersistRead — cache miss", () => {
  it("leaves cache null when AsyncStorage has no entry", async () => {
    mockGetItem.mockResolvedValue(null);
    await initPersistRead();
    expect(getCachedData()).toBeNull();
    expect(hasCachedData()).toBe(false);
  });

  it("leaves cache null when AsyncStorage returns an empty string", async () => {
    mockGetItem.mockResolvedValue("");
    await initPersistRead();
    expect(getCachedData()).toBeNull();
  });

  it("leaves cache null and does not throw when AsyncStorage rejects", async () => {
    mockGetItem.mockRejectedValue(new Error("storage error"));
    await expect(initPersistRead()).resolves.toBeUndefined();
    expect(getCachedData()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("initPersistRead — cache hit, matching hash", () => {
  beforeEach(() => {
    mockGetItem.mockResolvedValue(stored);
  });

  it("populates the in-memory cache with the stored entry", async () => {
    await initPersistRead();
    expect(getCachedData()).toEqual(SVG_DATA);
  });

  it("hasCachedData returns true", async () => {
    await initPersistRead();
    expect(hasCachedData()).toBe(true);
  });

  it("getIfValid returns data for the matching hash", async () => {
    await initPersistRead();
    expect(getIfValid(HASH)).toEqual(SVG_DATA);
  });

  it("getIfValid returns null for a different hash", async () => {
    await initPersistRead();
    expect(getIfValid("different-hash")).toBeNull();
  });

  it("reads from the correct AsyncStorage key", async () => {
    await initPersistRead();
    expect(mockGetItem).toHaveBeenCalledWith(STORAGE_KEY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("initPersistRead — cache hit, stale hash", () => {
  it("loads the stored data into memory even when the hash is different", async () => {
    // The data is still pre-populated so the user sees something immediately;
    // the caller is responsible for re-fetching when the hash mismatches.
    mockGetItem.mockResolvedValue(stored);
    await initPersistRead();
    // getCachedData returns the stale data (used for optimistic render)
    expect(getCachedData()).toEqual(SVG_DATA);
    // getIfValid returns null for the new hash (signals re-fetch needed)
    expect(getIfValid("new-build-hash")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("initPersistRead — malformed stored data", () => {
  it("discards an entry where hash is not a string", async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ hash: 42, ...SVG_DATA }),
    );
    await initPersistRead();
    expect(getCachedData()).toBeNull();
  });

  it("discards an entry where xml is not a string", async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ hash: HASH, xml: null, innerXml: "", uri: "" }),
    );
    await initPersistRead();
    expect(getCachedData()).toBeNull();
  });

  it("discards an entry where innerXml is missing", async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ hash: HASH, xml: "<svg/>", uri: "" }),
    );
    await initPersistRead();
    expect(getCachedData()).toBeNull();
  });

  it("discards corrupted (non-JSON) stored data without throwing", async () => {
    mockGetItem.mockResolvedValue("this is not valid json {{{{");
    await expect(initPersistRead()).resolves.toBeUndefined();
    expect(getCachedData()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("initPersistRead — promise deduplication", () => {
  it("returns the same promise on repeated calls", async () => {
    mockGetItem.mockResolvedValue(null);
    const p1 = initPersistRead();
    const p2 = initPersistRead();
    expect(p1).toBe(p2);
    await p1;
    // AsyncStorage should only have been called once
    expect(mockGetItem).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite in-memory cache that was already populated", async () => {
    // Simulate the case where _cache was set before the read resolves
    // (should not happen in practice, but the guard protects against it).
    setCached(HASH, SVG_DATA);
    mockGetItem.mockResolvedValue(
      JSON.stringify({ hash: "other-hash", xml: "other", innerXml: "other", uri: "" }),
    );
    _resetForTests(); // clears _readPromise so initPersistRead runs again
    // Manually restore cache before read resolves
    // (simulate race where setCached was called before module load)
    // We test via the `if (!raw || _cache !== null) return` guard:
    // manually set cache, then run read — read must not overwrite it.
    mockGetItem.mockImplementation(async () => {
      // By the time the .then callback fires, _cache has been set externally
      setCached(HASH, SVG_DATA);
      return stored;
    });
    await initPersistRead();
    // Cache still holds the value set by setCached, not the stored entry
    expect(getIfValid(HASH)).toEqual(SVG_DATA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("setCached", () => {
  it("stores data in the in-memory cache", () => {
    setCached(HASH, SVG_DATA);
    expect(getCachedData()).toEqual(SVG_DATA);
    expect(hasCachedData()).toBe(true);
  });

  it("makes getIfValid return data for the stored hash", () => {
    setCached(HASH, SVG_DATA);
    expect(getIfValid(HASH)).toEqual(SVG_DATA);
  });

  it("makes getIfValid return null for a different hash", () => {
    setCached(HASH, SVG_DATA);
    expect(getIfValid("other-hash")).toBeNull();
  });

  it("writes to AsyncStorage with the correct key and payload", async () => {
    setCached(HASH, SVG_DATA);
    // Fire-and-forget — flush microtasks
    await Promise.resolve();
    expect(mockSetItem).toHaveBeenCalledTimes(1);
    expect(mockSetItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify({ hash: HASH, ...SVG_DATA }),
    );
  });

  it("updates the cached hash when called a second time", () => {
    const data1: SvgData = { xml: "v1", innerXml: "v1-inner", uri: "" };
    const data2: SvgData = { xml: "v2", innerXml: "v2-inner", uri: "" };
    setCached("hash-v1", data1);
    setCached("hash-v2", data2);
    expect(getIfValid("hash-v2")).toEqual(data2);
    expect(getIfValid("hash-v1")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("setFallbackEmpty", () => {
  it("sets an empty SvgData entry in memory", () => {
    setFallbackEmpty();
    expect(hasCachedData()).toBe(true);
    expect(getCachedData()).toEqual({ xml: "", innerXml: "", uri: "" });
  });

  it("does not write to AsyncStorage", () => {
    setFallbackEmpty();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing valid cache", async () => {
    mockGetItem.mockResolvedValue(stored);
    await initPersistRead();
    setFallbackEmpty();
    // Should still have the real data, not empty
    expect(getCachedData()).toEqual(SVG_DATA);
  });

  it("does not overwrite data set by setCached", () => {
    setCached(HASH, SVG_DATA);
    setFallbackEmpty();
    expect(getCachedData()).toEqual(SVG_DATA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getIfValid", () => {
  it("returns null before any data is loaded", () => {
    expect(getIfValid(HASH)).toBeNull();
  });

  it("returns null after an empty fallback is set", () => {
    setFallbackEmpty();
    // An empty fallback has _cachedHash === null, so no hash can match.
    expect(getIfValid(HASH)).toBeNull();
    expect(getIfValid("")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: stale web cache with innerXml: "" must not suppress re-fetch
// ─────────────────────────────────────────────────────────────────────────────
describe("stale web cache — innerXml empty regression", () => {
  const SERVER_HASH = "server-hash-abc";
  const staleEntry = JSON.stringify({
    hash: SERVER_HASH,
    xml: "<svg><g/></svg>",
    innerXml: "",          // ← stale: written before the web SVG-strip fix
    uri: "",
  });

  beforeEach(() => {
    mockGetItem.mockResolvedValue(staleEntry);
  });

  it("populates the cache from AsyncStorage even when innerXml is empty", async () => {
    await initPersistRead();
    // The raw cache entry is present — hasCachedData and getCachedData both
    // see it (they don't filter by innerXml).
    expect(hasCachedData()).toBe(true);
    const data = getCachedData();
    expect(data).not.toBeNull();
    expect(data!.innerXml).toBe("");
  });

  it("getIfValid returns the stale entry (callers must apply the web innerXml guard)", async () => {
    // getIfValid only checks the hash; it is the caller's responsibility
    // (WarehouseMapView._loadFloorPlanFromServer / _loadFloorPlanFromBundle)
    // to reject entries with innerXml: "" on web and re-fetch.
    await initPersistRead();
    const stale = getIfValid(SERVER_HASH);
    expect(stale).not.toBeNull();
    expect(stale!.innerXml).toBe("");
  });

  it("after re-fetch setCached overwrites the stale entry with a non-empty innerXml", async () => {
    await initPersistRead();
    // Simulate what _loadFloorPlanFromServer does after detecting a stale cache:
    // it strips the SVG wrapper and stores the real content.
    const freshData: SvgData = {
      xml: "<svg><g id='real'/></svg>",
      innerXml: "<g id='real'/>",
      uri: "",
    };
    setCached(SERVER_HASH, freshData);

    // In-memory cache now has the real innerXml.
    expect(getCachedData()!.innerXml).toBe("<g id='real'/>");
    // getIfValid returns the updated entry — no stale data remains.
    expect(getIfValid(SERVER_HASH)!.innerXml).toBe("<g id='real'/>");

    // AsyncStorage was updated (fire-and-forget).
    await Promise.resolve();
    expect(mockSetItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify({ hash: SERVER_HASH, ...freshData }),
    );
  });
});
