/**
 * tilePyramidCache — on-device PNG tile cache for the warehouse floor plan.
 *
 * Tiles are downloaded from the API and stored to
 *   FileSystem.cacheDirectory + 'map-tiles/{svgHash}/{z}_{x}_{y}.png'
 * so they survive app restarts but can be cleaned up by the OS when
 * storage is low.  Stale directories (from a previous SVG hash) are
 * deleted on startup via cleanStaleCacheDirs(). Old interrupted prefetch
 * downloads in the current hash directory are also removed then.
 *
 * Web is not affected — all functions return immediately without
 * touching the filesystem.
 */

import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { tileApiUrl } from "@/utils/floorPlan";

const TILES_BASE_DIR = (FileSystem.cacheDirectory ?? "") + "map-tiles/";
const INTERRUPTED_PREFETCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const activePrefetchFiles = new Set<string>();

function tileHashDir(svgHash: string): string {
  return TILES_BASE_DIR + svgHash + "/";
}

function localTilePath(z: number, x: number, y: number, svgHash: string): string {
  return tileHashDir(svgHash) + `${z}_${x}_${y}.png`;
}

/**
 * Return a local `file://` URI for tile (z, x, y) of the floor plan with the
 * given SVG content hash.  Downloads from the API if not already cached.
 *
 * On web (no FileSystem caching) returns the API URL directly.
 *
 * Throws if the download fails (HTTP non-200 or network error).
 */
export async function fetchTile(
  z: number,
  x: number,
  y: number,
  svgHash: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException("Tile download cancelled", "AbortError");
  if (Platform.OS === "web" || !FileSystem.cacheDirectory || !svgHash) {
    return tileApiUrl(z, x, y);
  }

  const local = localTilePath(z, x, y, svgHash);

  const info = await FileSystem.getInfoAsync(local);
  if (signal?.aborted) throw new DOMException("Tile download cancelled", "AbortError");
  if (info.exists) return local;

  const dir = tileHashDir(svgHash);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  if (signal?.aborted) throw new DOMException("Tile download cancelled", "AbortError");

  // Legacy downloadAsync has no cancellation handle. Prefetch uses a resumable
  // download so an obsolete zoom actually stops network and file I/O.
  let result: FileSystem.FileSystemDownloadResult | undefined;
  if (signal) {
    // Separate temporary files keep an old zoom's cancellation from deleting
    // a new zoom's download of the same tile.
    const temporary = `${local}.prefetch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const download = FileSystem.createDownloadResumable(tileApiUrl(z, x, y), temporary);
    activePrefetchFiles.add(temporary);
    const onAbort = () => { void download.cancelAsync().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) throw new DOMException("Tile download cancelled", "AbortError");
      result = await download.downloadAsync();
      if (signal.aborted) throw new DOMException("Tile download cancelled", "AbortError");
      if (!result) throw new DOMException("Tile download cancelled", "AbortError");
      if (result.status === 200) {
        await FileSystem.moveAsync({ from: temporary, to: local });
      }
    } catch (error) {
      await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      activePrefetchFiles.delete(temporary);
    }
    if (result.status !== 200) {
      await FileSystem.deleteAsync(temporary, { idempotent: true });
      throw new Error(`tile ${z}/${x}/${y} download failed with status ${result.status}`);
    }
    return local;
  } else {
    result = await FileSystem.downloadAsync(tileApiUrl(z, x, y), local);
  }
  if (result.status !== 200) {
    await FileSystem.deleteAsync(local, { idempotent: true });
    throw new Error(`tile ${z}/${x}/${y} download failed with status ${result.status}`);
  }
  return local;
}

/**
 * Prefetch all tiles for zoom level `z` that fall within `range` (plus a
 * 1-tile buffer already baked into the range by the caller).  At most four
 * downloads run at once; individual failures are silently ignored so one bad tile
 * doesn't block the rest.
 *
 * Pass an `AbortSignal` to cancel in-flight work when a newer gesture starts.
 * Tiles already written to disk are not removed — the cache remains valid.
 */
export async function prefetchZoomLevel(
  z: number,
  range: { c0: number; c1: number; r0: number; r1: number },
  svgHash: string,
  signal?: AbortSignal,
): Promise<void> {
  if (Platform.OS === "web" || !svgHash) return;

  let row = range.r0;
  let col = range.c0;
  const worker = async () => {
    while (!signal?.aborted && row <= range.r1) {
      const x = col;
      const y = row;
      if (++col > range.c1) { col = range.c0; row++; }
      try { await fetchTile(z, x, y, svgHash, signal); } catch { /* best effort */ }
    }
  };
  const count = Math.min(4, Math.max(0, range.c1 - range.c0 + 1) * Math.max(0, range.r1 - range.r0 + 1));
  await Promise.all(Array.from({ length: count }, worker));
}

/**
 * Delete cached tile directories whose hash does not match `currentHash`,
 * plus old interrupted prefetch downloads in the current hash directory.
 * Call once on map mount after the SVG hash is known.
 *
 * Non-fatal — any deletion failure is silently ignored.
 */
export async function cleanStaleCacheDirs(currentHash: string): Promise<void> {
  if (Platform.OS === "web" || !FileSystem.cacheDirectory || !currentHash) return;

  try {
    const info = await FileSystem.getInfoAsync(TILES_BASE_DIR);
    if (!info.exists) return;

    const entries = await FileSystem.readDirectoryAsync(TILES_BASE_DIR);
    await Promise.all(
      entries
        .filter((entry) => entry !== currentHash)
        .map((entry) =>
          FileSystem.deleteAsync(TILES_BASE_DIR + entry, { idempotent: true }).catch(() => {}),
        ),
    );
    if (!entries.includes(currentHash)) return;

    const currentDir = tileHashDir(currentHash);
    const cutoff = Date.now() - INTERRUPTED_PREFETCH_MAX_AGE_MS;
    const files = await FileSystem.readDirectoryAsync(currentDir);
    await Promise.all(files.map(async (file) => {
      // Match only our exact temporary filename shape; never delete a completed
      // tile or an unrelated file in the current map's cache.
      const match = /^\d+_\d+_\d+\.png\.prefetch-(\d+)-([a-z0-9]+)$/.exec(file);
      if (!match) return;
      const createdAt = Number(match[1]);
      if (!Number.isSafeInteger(createdAt) || createdAt > cutoff) return;
      const path = currentDir + file;
      if (activePrefetchFiles.has(path)) return;
      try {
        const info = await FileSystem.getInfoAsync(path);
        if (!info.exists || info.isDirectory || !info.modificationTime ||
            info.modificationTime * 1000 > cutoff || activePrefetchFiles.has(path)) return;
        await FileSystem.deleteAsync(path, { idempotent: true });
      } catch {
        // A missing or locked file can be retried on the next map mount.
      }
    }));
  } catch {
    // Non-fatal — stale directories will be cleaned on the next launch.
  }
}
