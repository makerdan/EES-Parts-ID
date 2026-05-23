/** Transform state for the SVG pan/zoom canvas. */
export interface Tf {
  x: number;
  y: number;
  s: number;
}

export const ZOOM_IN_FACTOR = 1.12;
export const ZOOM_OUT_FACTOR = 1 / 1.12;
export const MIN_SCALE = 0.03;
export const MAX_SCALE = 10;

/**
 * Compute the new transform after a wheel-zoom event.
 *
 * @param curr   Current transform (pan x/y in screen pixels, scale s).
 * @param mx     Mouse X relative to the SVG element's top-left corner.
 * @param my     Mouse Y relative to the SVG element's top-left corner.
 * @param deltaY WheelEvent.deltaY — negative means zoom-in, positive zoom-out.
 */
export function computeWheelZoom(
  curr: Tf,
  mx: number,
  my: number,
  deltaY: number,
): Tf {
  const svgX = (mx - curr.x) / curr.s;
  const svgY = (my - curr.y) / curr.s;
  const factor = deltaY < 0 ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR;
  const newS = Math.max(MIN_SCALE, Math.min(MAX_SCALE, curr.s * factor));
  return { x: mx - svgX * newS, y: my - svgY * newS, s: newS };
}
