/**
 * floorPlan.ts — client-side helpers for floor-plan tile management.
 *
 * warmupTiles() asks the API server to pre-generate z0–z2 tiles so the
 * first few zoom levels are instantly available on the device after mount.
 * The call is fire-and-forget: the server responds 202 Accepted immediately
 * and does the work asynchronously.
 *
 * tileApiUrl() returns the canonical URL for a single PNG tile, mirroring
 * the private helper in tilePyramidCache.ts so callers that don't need
 * caching can construct URLs without importing the full cache module.
 */

import { Platform } from "react-native";

import { API_BASE } from "@/utils/apiBase";
import { fetchWithAuth, getAuthToken } from "@/utils/appAuth";

/**
 * Return the API URL for tile (z, x, y).
 * The API server strips the .png extension from the :y route param, so the
 * .png suffix is purely cosmetic but keeps URLs consistent with standard map
 * tile conventions.
 */
export function tileApiUrl(z: number, x: number, y: number): string {
  return `${API_BASE}/floor-plan/tiles/${z}/${x}/${y}.png`;
}

/**
 * Ask the API server to pre-warm z0–z2 tiles for the current floor plan.
 *
 * The server returns 202 Accepted immediately and generates tiles in the
 * background, so this function resolves quickly regardless of how many tiles
 * need to be rasterised.  Failures are silently swallowed — the PngTile
 * components will fetch individual tiles on demand if warmup didn't run.
 *
 * No-op on web (tiles are not used on web) or when no API base is configured
 * (local dev without EXPO_PUBLIC_DOMAIN set).
 *
 * @param _svgHash  The current floor-plan SVG content hash.  Passed through
 *                  for future server-side keying; not yet used by the server
 *                  but kept in the signature so callers don't need to change
 *                  when that optimisation lands.
 */
export async function warmupTiles(_svgHash: string): Promise<void> {
  if (Platform.OS === "web" || !API_BASE || !getAuthToken()) return;
  try {
    await fetchWithAuth(`${API_BASE}/floor-plan/tiles/warmup`, { method: "POST" });
  } catch {
    // Non-fatal — tiles will be generated on first request.
  }
}
