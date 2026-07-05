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
  // ── Zoom-at-pointer derivation ────────────────────────────────────────────
  // The screen↔content transform is: screen = content * s + pan, i.e.
  //   screenX = svgX * curr.s + curr.x
  // Goal: keep the content point that currently sits under the cursor pinned
  // to the same cursor pixel after the scale changes, so the map appears to
  // zoom "into" the mouse rather than into the origin.
  //
  // 1. Invert the transform to recover the content-space point under the cursor
  //    at the current scale (this point must not move on screen):
  //       svgX = (mx - curr.x) / curr.s
  const svgX = (mx - curr.x) / curr.s;
  const svgY = (my - curr.y) / curr.s;
  // 2. Pick the multiplicative zoom step (wheel up / deltaY < 0 = zoom in) and
  //    clamp the resulting scale to the allowed range.
  const factor = deltaY < 0 ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR;
  const newS = Math.max(MIN_SCALE, Math.min(MAX_SCALE, curr.s * factor));
  // 3. Solve the forward transform at the NEW scale for the pan that keeps that
  //    same content point (svgX, svgY) under the same cursor pixel (mx, my):
  //       mx = svgX * newS + x   ⇒   x = mx - svgX * newS
  //    Note: newS may equal curr.s at the clamp limits, in which case the pan
  //    is unchanged and the wheel event is effectively a no-op.
  return { x: mx - svgX * newS, y: my - svgY * newS, s: newS };
}
