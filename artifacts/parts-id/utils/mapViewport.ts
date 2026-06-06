/**
 * Pure math helpers for the warehouse map viewport.
 *
 * Extracted from WarehouseMapView so they can be unit-tested without
 * importing any React Native or Reanimated dependencies.
 */

// Must match the viewBox attribute of the floor-plan SVG served by
// /api/floor-plan/svg.  Verify with:
//   curl .../api/floor-plan/svg | grep -oP 'viewBox="[^"]+"' | head -1
export const SVG_VIEWBOX_W = 7329.6001;
export const SVG_VIEWBOX_H = 4997.2798;
export const SVG_ASPECT = SVG_VIEWBOX_W / SVG_VIEWBOX_H;

export const MIN_SCALE = 0.8;
export const MAX_SCALE = 50;
export const FIT_PADDING = 16;

export interface ContentViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Parse the `viewBox="x y w h"` attribute from an SVG XML string.
 * Returns null when the attribute is absent or malformed.
 */
export function parseContentViewBox(xml: string): ContentViewBox | null {
  const match = xml.match(/viewBox="([^"]+)"/);
  if (!match) return null;
  const parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Compute a "fit to content" viewport that centres the content rect inside
 * the container using a meet-style scale with FIT_PADDING on every side.
 *
 * The SVG render area is svgRenderW × svgRenderH (= containerW × containerW/aspect)
 * and is centred in the container.  The Animated.View transform is
 *   [translateX, translateY, scale]
 * where scale pivots around the view centre, then the translation shifts it.
 * Content centre in screen space = containerCentre + (tx,ty) + (dx,dy)*s
 * where dx/dy is the content-centre offset from the SVG render-area centre.
 * Setting that to zero gives tx = -dx*s, ty = -dy*s.
 *
 * NOTE: Do NOT clamp tx/ty to pan bounds here.  Pan bounds are derived from
 * the full SVG render area, which is often larger than the container in X
 * but smaller in Y (letterboxed portrait).  Clamping ty to maxY=0 in the
 * letterboxed case would leave content off-centre.  Gesture handlers apply
 * their own per-axis clamping during user interaction.
 */
export function fitContentViewport(
  contentVB: ContentViewBox,
  containerW: number,
  containerH: number,
  svgVBW: number,
  svgVBH: number,
): { scale: number; tx: number; ty: number } {
  const svgRenderW = containerW;
  const svgRenderH = containerW / (svgVBW / svgVBH);
  const pixelW = (contentVB.w / svgVBW) * svgRenderW;
  const pixelH = (contentVB.h / svgVBH) * svgRenderH;
  const availW = containerW - FIT_PADDING * 2;
  const availH = containerH - FIT_PADDING * 2;
  const rawScale = Math.min(availW / pixelW, availH / pixelH);
  const fittedScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, rawScale));
  const contentCenterX = ((contentVB.x + contentVB.w / 2) / svgVBW) * svgRenderW;
  const contentCenterY = ((contentVB.y + contentVB.h / 2) / svgVBH) * svgRenderH;
  const dx = contentCenterX - svgRenderW / 2;
  const dy = contentCenterY - svgRenderH / 2;
  return { scale: fittedScale, tx: -dx * fittedScale, ty: -dy * fittedScale };
}

/**
 * Compute the viewBox string for tile (col, row) in an N×N grid.
 * Used to replace the SVG's viewBox attribute when rendering individual tiles.
 */
export function makeTileViewBox(
  col: number,
  row: number,
  N: number,
  svgVBW: number,
  svgVBH: number,
): string {
  const vbW = svgVBW / N;
  const vbH = svgVBH / N;
  return `${col * vbW} ${row * vbH} ${vbW} ${vbH}`;
}

/**
 * Clamp a pinch-gesture (or programmatic) scale to the valid zoom range
 * [MIN_SCALE, MAX_SCALE].  Any value below MIN_SCALE is brought up to it;
 * any value above MAX_SCALE is brought down to it.
 *
 * Applied in gesture handlers, the +/− button callback, and when restoring
 * a persisted viewport — a single, testable rule for all zoom paths.
 */
export function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

/**
 * Compute the maximum safe translation (pan limits) for a given container
 * size and scale.
 *
 * The SVG renders at containerW × (containerW / SVG_ASPECT) points.  At a
 * given scale the rendered area grows by that factor.  Each axis allows panning
 * up to half the overflow past the container edge (because the transform pivots
 * around the view centre).  When the scaled map is smaller than the container
 * on an axis — i.e. in the "letterboxed" portrait case for Y — that axis
 * returns 0 and no panning is permitted.
 *
 * Returns { maxX, maxY } — always ≥ 0.
 */
export function panBounds(
  containerW: number,
  containerH: number,
  scale: number,
): { maxX: number; maxY: number } {
  const svgRenderH = containerW / SVG_ASPECT;
  return {
    maxX: Math.max(0, (containerW * scale - containerW) / 2),
    maxY: Math.max(0, (svgRenderH * scale - containerH) / 2),
  };
}

/**
 * The number of tile rows (and columns) to use at a given scale.
 *
 * numTiles = ceil(scale) so the grid advances by integer steps only.
 * Examples:
 *   scale 0.8–1.0 → 1  (single texture, no split)
 *   scale 1.01–2.0 → 2  (2×2 = 4 tiles)
 *   scale 2.01–3.0 → 3  (3×3 = 9 tiles)
 *
 * NOTE: The actual number of tiles rendered is further capped by the device's
 * maximum texture size (IOS_MAX_TEXTURE_PX) inside WarehouseMapView.  That cap
 * is device-specific.  This function returns the pure formula result.
 */
export function numTilesForScale(scale: number): number {
  return Math.ceil(scale);
}

/**
 * Compute the column and row range of tiles that are visible (or nearly
 * visible) in the current viewport.  Includes a 1-tile buffer on every edge
 * to prevent pop-in on slow scrolls, and is clamped to [0, N−1].
 *
 * Mirrors the worklet-side calculation in WarehouseMapView so the same logic
 * can be unit-tested without Reanimated.
 *
 * @param N          Tile grid dimension (N×N grid).
 * @param svgRenderW Rendered SVG width in points (equals containerW).
 * @param scale      Current zoom scale.
 * @param tx         Current X translation (viewport transform, centred pivot).
 * @param ty         Current Y translation.
 * @param containerW Container width in points.
 * @param containerH Container height in points.
 */
export function visibleTileRange(
  N: number,
  svgRenderW: number,
  scale: number,
  tx: number,
  ty: number,
  containerW: number,
  containerH: number,
): { c0: number; c1: number; r0: number; r1: number } {
  if (N <= 1 || svgRenderW <= 0) {
    return { c0: 0, c1: Math.max(0, N - 1), r0: 0, r1: Math.max(0, N - 1) };
  }
  const H = svgRenderW / SVG_ASPECT;
  const tileW = svgRenderW / N;
  const tileH = H / N;
  const visCX = svgRenderW / 2 - tx / scale;
  const visCY = H / 2 - ty / scale;
  const visW = containerW / scale;
  const visH = containerH / scale;
  return {
    c0: Math.max(0, Math.floor((visCX - visW / 2) / tileW) - 1),
    c1: Math.min(N - 1, Math.ceil((visCX + visW / 2) / tileW)),
    r0: Math.max(0, Math.floor((visCY - visH / 2) / tileH) - 1),
    r1: Math.min(N - 1, Math.ceil((visCY + visH / 2) / tileH)),
  };
}
