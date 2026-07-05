/**
 * SVG coordinate conversion utilities shared across map interaction components
 * (ZoneEditor and any future SVG-canvas viewer).
 *
 * The canvas transform is represented as a { x, y, s } triple where:
 *   - (x, y) is the translation of the SVG origin relative to the container
 *   - s       is the uniform scale factor
 *
 * Screen → SVG:  svgPt = (screenPt - containerOrigin - translate) / scale
 * SVG → Screen:  screenPt = svgPt * scale + translate + containerOrigin
 */

export interface SvgTransform {
  x: number;
  y: number;
  s: number;
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * Converts a pointer event's client coordinates to SVG-canvas coordinates.
 *
 * @param clientX  Pointer clientX (from MouseEvent / PointerEvent)
 * @param clientY  Pointer clientY
 * @param rect     Bounding rect of the SVG element (from getBoundingClientRect)
 * @param tf       Current canvas transform { x, y, s }
 */
export function screenToSvg(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  tf: SvgTransform,
): Pt {
  return {
    x: (clientX - rect.left - tf.x) / tf.s,
    y: (clientY - rect.top - tf.y) / tf.s,
  };
}

/**
 * Converts SVG-canvas coordinates back to container-relative screen coordinates.
 *
 * @param pt   Point in SVG-canvas space
 * @param tf   Current canvas transform { x, y, s }
 */
export function svgToScreen(pt: Pt, tf: SvgTransform): Pt {
  return {
    x: pt.x * tf.s + tf.x,
    y: pt.y * tf.s + tf.y,
  };
}
