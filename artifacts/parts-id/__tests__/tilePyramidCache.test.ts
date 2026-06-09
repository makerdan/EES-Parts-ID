/**
 * Unit tests for tilePyramidCache — on-device PNG tile caching helpers.
 *
 * Covered functions:
 *   fetchTile          — cache-miss download, cache-hit skip, web/empty-hash no-ops,
 *                        non-200 download cleans up and throws.
 *   cleanStaleCacheDirs — no-ops on web / empty hash / absent root dir;
 *                         deletes non-matching subdirs, keeps the current one.
 *   prefetchZoomLevel  — no-ops on web / empty hash; fires one fetch per tile in
 *                        range; individual failures are silently swallowed;
 *                        respects AbortSignal.
 *
 * Mock wiring:
 *   react-native       → __mocks__/react-native.js  (Platform.OS writable, default "ios")
 *   expo-file-system/legacy → __mocks__/expo-file-system-legacy.js
 */

import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import {
  fetchTile,
  prefetchZoomLevel,
  cleanStaleCacheDirs,
} from "@/utils/tilePyramidCache";

// ── typed handles to the jest.fn() mocks ───────────────────────────────────
const mockGetInfo   = FileSystem.getInfoAsync       as jest.MockedFunction<typeof FileSystem.getInfoAsync>;
const mockMakeDir   = FileSystem.makeDirectoryAsync as jest.MockedFunction<typeof FileSystem.makeDirectoryAsync>;
const mockDownload  = FileSystem.downloadAsync      as jest.MockedFunction<typeof FileSystem.downloadAsync>;
const mockDelete    = FileSystem.deleteAsync        as jest.MockedFunction<typeof FileSystem.deleteAsync>;
const mockReadDir   = FileSystem.readDirectoryAsync as jest.MockedFunction<typeof FileSystem.readDirectoryAsync>;

// Derived constants that mirror the production module (cacheDirectory = "file:///mock-cache/").
const TILES_BASE   = "file:///mock-cache/map-tiles/";
const HASH         = "abc123";
const HASH_DIR     = `${TILES_BASE}${HASH}/`;
const LOCAL_TILE   = `${HASH_DIR}0_0_0.png`;
const API_TILE_URL = "/floor-plan/tiles/0/0/0.png"; // EXPO_PUBLIC_DOMAIN unset → API_BASE=""

// Helpers to satisfy the FileInfo discriminated union.
// exists:true  → requires size + modificationTime; isDirectory must be a literal.
// exists:false → isDirectory must be literal false.
const FILE_EXISTS    = { exists: true  as const, isDirectory: false as const, uri: LOCAL_TILE, size: 0, modificationTime: 0 };
const FILE_EXISTS_BLANK = { exists: true as const, isDirectory: false as const, uri: "", size: 0, modificationTime: 0 };
const DIR_EXISTS     = { exists: true  as const, isDirectory: true  as const, uri: TILES_BASE, size: 0, modificationTime: 0 };
const FILE_MISSING   = { exists: false as const, isDirectory: false as const, uri: LOCAL_TILE };
const DIR_MISSING    = { exists: false as const, isDirectory: false as const, uri: TILES_BASE };
const FILE_MISSING_BLANK = { exists: false as const, isDirectory: false as const, uri: "" };

beforeEach(() => {
  jest.clearAllMocks();
  // Default Platform: native (iOS) so filesystem paths are exercised.
  (Platform as { OS: string }).OS = "ios";
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchTile
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchTile — cache miss → download", () => {
  it("calls downloadAsync with the correct API URL and local path on a cache miss", async () => {
    mockGetInfo.mockResolvedValueOnce(FILE_MISSING);
    mockDownload.mockResolvedValueOnce({ status: 200, uri: LOCAL_TILE, headers: {}, mimeType: null });

    const result = await fetchTile(0, 0, 0, HASH);

    expect(mockGetInfo).toHaveBeenCalledWith(LOCAL_TILE);
    expect(mockMakeDir).toHaveBeenCalledWith(HASH_DIR, { intermediates: true });
    expect(mockDownload).toHaveBeenCalledWith(API_TILE_URL, LOCAL_TILE);
    expect(result).toBe(LOCAL_TILE);
  });

  it("returns the local path on a successful download", async () => {
    mockGetInfo.mockResolvedValueOnce(FILE_MISSING);
    mockDownload.mockResolvedValueOnce({ status: 200, uri: LOCAL_TILE, headers: {}, mimeType: null });

    await expect(fetchTile(0, 0, 0, HASH)).resolves.toBe(LOCAL_TILE);
  });
});

describe("fetchTile — cache hit → skip download", () => {
  it("returns the local path immediately without calling downloadAsync when the file already exists", async () => {
    mockGetInfo.mockResolvedValueOnce(FILE_EXISTS);

    const result = await fetchTile(0, 0, 0, HASH);

    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockMakeDir).not.toHaveBeenCalled();
    expect(result).toBe(LOCAL_TILE);
  });
});

describe("fetchTile — web platform no-op", () => {
  it("returns the API URL directly on web without touching the filesystem", async () => {
    (Platform as { OS: string }).OS = "web";

    const result = await fetchTile(0, 0, 0, HASH);

    expect(result).toBe(API_TILE_URL);
    expect(mockGetInfo).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("returns the correct z/x/y-interpolated API URL for z=2, x=3, y=1 on web", async () => {
    (Platform as { OS: string }).OS = "web";

    const result = await fetchTile(2, 3, 1, HASH);

    expect(result).toBe("/floor-plan/tiles/2/3/1.png");
  });
});

describe("fetchTile — empty svgHash no-op", () => {
  it("returns the API URL when svgHash is empty string, without touching the filesystem", async () => {
    const result = await fetchTile(0, 0, 0, "");

    expect(result).toBe(API_TILE_URL);
    expect(mockGetInfo).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe("fetchTile — non-200 download failure", () => {
  it("throws an error describing the failed tile when download returns 404", async () => {
    mockGetInfo.mockResolvedValueOnce(FILE_MISSING);
    mockDownload.mockResolvedValueOnce({ status: 404, uri: LOCAL_TILE, headers: {}, mimeType: null });

    await expect(fetchTile(0, 0, 0, HASH)).rejects.toThrow("0/0/0");
  });

  it("deletes the partial file after a failed download", async () => {
    mockGetInfo.mockResolvedValueOnce(FILE_MISSING);
    mockDownload.mockResolvedValueOnce({ status: 500, uri: LOCAL_TILE, headers: {}, mimeType: null });

    await expect(fetchTile(0, 0, 0, HASH)).rejects.toThrow();
    expect(mockDelete).toHaveBeenCalledWith(LOCAL_TILE, { idempotent: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanStaleCacheDirs
// ─────────────────────────────────────────────────────────────────────────────

describe("cleanStaleCacheDirs — early-return guards", () => {
  it("returns immediately on web without touching the filesystem", async () => {
    (Platform as { OS: string }).OS = "web";

    await cleanStaleCacheDirs(HASH);

    expect(mockGetInfo).not.toHaveBeenCalled();
    expect(mockReadDir).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("returns immediately when currentHash is empty", async () => {
    await cleanStaleCacheDirs("");

    expect(mockGetInfo).not.toHaveBeenCalled();
    expect(mockReadDir).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("returns without reading entries when TILES_BASE_DIR does not exist yet", async () => {
    mockGetInfo.mockResolvedValueOnce(DIR_MISSING);

    await cleanStaleCacheDirs(HASH);

    expect(mockReadDir).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("cleanStaleCacheDirs — stale directory removal", () => {
  it("deletes directories whose hash does not match currentHash", async () => {
    mockGetInfo.mockResolvedValueOnce(DIR_EXISTS);
    mockReadDir.mockResolvedValueOnce(["stale1", "stale2", HASH]);

    await cleanStaleCacheDirs(HASH);

    expect(mockDelete).toHaveBeenCalledWith(`${TILES_BASE}stale1`, { idempotent: true });
    expect(mockDelete).toHaveBeenCalledWith(`${TILES_BASE}stale2`, { idempotent: true });
  });

  it("does NOT delete the directory matching currentHash", async () => {
    mockGetInfo.mockResolvedValueOnce(DIR_EXISTS);
    mockReadDir.mockResolvedValueOnce(["stale1", HASH]);

    await cleanStaleCacheDirs(HASH);

    expect(mockDelete).not.toHaveBeenCalledWith(`${TILES_BASE}${HASH}`, expect.anything());
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it("deletes nothing when every directory matches currentHash", async () => {
    mockGetInfo.mockResolvedValueOnce(DIR_EXISTS);
    mockReadDir.mockResolvedValueOnce([HASH]);

    await cleanStaleCacheDirs(HASH);

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("is non-fatal: does not throw even when deleteAsync rejects", async () => {
    mockGetInfo.mockResolvedValueOnce(DIR_EXISTS);
    mockReadDir.mockResolvedValueOnce(["stale1"]);
    mockDelete.mockRejectedValueOnce(new Error("disk full"));

    await expect(cleanStaleCacheDirs(HASH)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prefetchZoomLevel
// ─────────────────────────────────────────────────────────────────────────────

describe("prefetchZoomLevel — early-return guards", () => {
  it("returns immediately on web without calling fetchTile", async () => {
    (Platform as { OS: string }).OS = "web";

    await prefetchZoomLevel(0, { c0: 0, c1: 0, r0: 0, r1: 0 }, HASH);

    expect(mockGetInfo).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("returns immediately when svgHash is empty", async () => {
    await prefetchZoomLevel(0, { c0: 0, c1: 0, r0: 0, r1: 0 }, "");

    expect(mockGetInfo).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe("prefetchZoomLevel — z0 edge case (1×1 grid = 1 tile)", () => {
  it("fires exactly one fetchTile for a z0 range {c0:0, c1:0, r0:0, r1:0}", async () => {
    // All tiles are cache misses so downloadAsync is called exactly once.
    mockGetInfo.mockResolvedValue(FILE_MISSING_BLANK);
    mockDownload.mockResolvedValue({ status: 200, uri: "file:///mock-cache/map-tiles/abc123/0_0_0.png", headers: {}, mimeType: null });

    await prefetchZoomLevel(0, { c0: 0, c1: 0, r0: 0, r1: 0 }, HASH);

    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockDownload).toHaveBeenCalledWith("/floor-plan/tiles/0/0/0.png", expect.stringContaining("0_0_0.png"));
  });
});

describe("prefetchZoomLevel — z4 edge case (4×4 range = 16 tiles)", () => {
  it("fires 16 fetchTile calls for a full 4×4 range at z4", async () => {
    // All tiles present on disk (cache hits) — no downloads, just getInfoAsync calls.
    mockGetInfo.mockResolvedValue(FILE_EXISTS_BLANK);

    await prefetchZoomLevel(4, { c0: 0, c1: 3, r0: 0, r1: 3 }, HASH);

    // One getInfoAsync per tile (16 tiles); no downloads since all are cache hits.
    expect(mockGetInfo).toHaveBeenCalledTimes(16);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("fires the correct number of fetchTile calls for the full 16×16 z4 grid", async () => {
    mockGetInfo.mockResolvedValue(FILE_EXISTS_BLANK);

    await prefetchZoomLevel(4, { c0: 0, c1: 15, r0: 0, r1: 15 }, HASH);

    expect(mockGetInfo).toHaveBeenCalledTimes(256); // 16×16
  });
});

describe("prefetchZoomLevel — individual tile failures are silently ignored", () => {
  it("resolves successfully even when one tile download fails", async () => {
    mockGetInfo.mockResolvedValue(FILE_MISSING_BLANK);
    // First download fails with network error; subsequent ones succeed.
    mockDownload
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValue({ status: 200, uri: "", headers: {}, mimeType: null });

    await expect(
      prefetchZoomLevel(1, { c0: 0, c1: 1, r0: 0, r1: 1 }, HASH),
    ).resolves.toBeUndefined();
  });

  it("resolves successfully even when all tile downloads fail", async () => {
    mockGetInfo.mockResolvedValue(FILE_MISSING_BLANK);
    mockDownload.mockRejectedValue(new Error("offline"));

    await expect(
      prefetchZoomLevel(1, { c0: 0, c1: 1, r0: 0, r1: 1 }, HASH),
    ).resolves.toBeUndefined();
  });

  it("resolves successfully when a download returns non-200 (fetchTile throws internally)", async () => {
    mockGetInfo.mockResolvedValue(FILE_MISSING_BLANK);
    mockDownload.mockResolvedValue({ status: 503, uri: "", headers: {}, mimeType: null });

    await expect(
      prefetchZoomLevel(0, { c0: 0, c1: 0, r0: 0, r1: 0 }, HASH),
    ).resolves.toBeUndefined();
  });
});

describe("prefetchZoomLevel — AbortSignal cancellation", () => {
  it("stops queuing new tiles when the signal is already aborted before the call", async () => {
    mockGetInfo.mockResolvedValue(FILE_MISSING_BLANK);
    mockDownload.mockResolvedValue({ status: 200, uri: "", headers: {}, mimeType: null });

    const controller = new AbortController();
    controller.abort();

    await prefetchZoomLevel(1, { c0: 0, c1: 1, r0: 0, r1: 1 }, HASH, controller.signal);

    // Signal is already aborted before the outer loop body runs, so zero or
    // very few tiles are enqueued (implementation breaks at first aborted check).
    expect(mockDownload).toHaveBeenCalledTimes(0);
  });
});
