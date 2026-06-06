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
