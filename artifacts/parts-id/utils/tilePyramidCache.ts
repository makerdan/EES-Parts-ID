/**
 * tilePyramidCache — on-device PNG tile cache for the warehouse floor plan.
 *
 * Tiles are downloaded from the API and stored to
 *   FileSystem.cacheDirectory + 'map-tiles/{svgHash}/{z}_{x}_{y}.png'
 * so they survive app restarts but can be cleaned up by the OS when
 * storage is low.  Stale directories (from a previous SVG hash) are
 * deleted on startup via cleanStaleCacheDirs().
 *
 * Web is not affected — all functions return immediately without
 * touching the filesystem.
 */

import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

const TILES_BASE_DIR = (FileSystem.cacheDirectory ?? "") + "map-tiles/";

function tileHashDir(svgHash: string): string {
  return TILES_BASE_DIR + svgHash + "/";
}

function localTilePath(z: number, x: number, y: number, svgHash: string): string {
  return tileHashDir(svgHash) + `${z}_${x}_${y}.png`;
}

function tileApiUrl(z: number, x: number, y: number): string {
  return `${API_BASE}/floor-plan/tiles/${z}/${x}/${y}.png`;
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
): Promise<string> {
  if (Platform.OS === "web" || !FileSystem.cacheDirectory || !svgHash) {
    return tileApiUrl(z, x, y);
  }

  const local = localTilePath(z, x, y, svgHash);

  const info = await FileSystem.getInfoAsync(local);
  if (info.exists) return local;

  const dir = tileHashDir(svgHash);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  const result = await FileSystem.downloadAsync(tileApiUrl(z, x, y), local);
  if (result.status !== 200) {
    await FileSystem.deleteAsync(local, { idempotent: true });
    throw new Error(`tile ${z}/${x}/${y} download failed with status ${result.status}`);
  }
  return local;
}

/**
 * Prefetch all tiles for zoom level `z` that fall within `range` (plus a
 * 1-tile buffer already baked into the range by the caller).  All fetches
 * run in parallel; individual failures are silently ignored so one bad tile
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

  const fetches: Array<Promise<void>> = [];
  for (let row = range.r0; row <= range.r1; row++) {
    for (let col = range.c0; col <= range.c1; col++) {
      if (signal?.aborted) break;
      fetches.push(
        fetchTile(z, col, row, svgHash).then(() => {}).catch(() => {}),
      );
    }
    if (signal?.aborted) break;
  }
  await Promise.all(fetches);
}

/**
 * Delete any cached tile directories whose hash does not match
 * `currentHash`.  Call once on map mount after the SVG hash is known so
 * stale tiles from a previous admin upload are cleaned up.
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
  } catch {
    // Non-fatal — stale directories will be cleaned on the next launch.
  }
}
