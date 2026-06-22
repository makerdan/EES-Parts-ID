/**
 * rubberBandSelect.ts
 *
 * Pure utility functions for rubber-band (shift-drag) zone selection.
 * No React dependency — safe to import in any context including pure tests.
 */

/** Minimal geometry shape required for hit-testing. */
export interface ZoneRect {
  svgX: number;
  svgY: number;
  svgWidth: number;
  svgHeight: number;
}

/**
 * Normalises any drag direction into a rect with non-negative width/height.
 * Works regardless of which corner the user started dragging from.
 */
export function normRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): ZoneRect {
  return {
    svgX: Math.min(x1, x2),
    svgY: Math.min(y1, y2),
    svgWidth: Math.abs(x2 - x1),
    svgHeight: Math.abs(y2 - y1),
  };
}

/**
 * Axis-aligned bounding-box overlap check.
 * Semantics: strict — zones that only *touch* an edge (share a boundary without
 * any interior overlap) are **not** considered intersecting.
 */
export function aabbIntersects(zone: ZoneRect, rect: ZoneRect): boolean {
  return (
    zone.svgX < rect.svgX + rect.svgWidth &&
    zone.svgX + zone.svgWidth > rect.svgX &&
    zone.svgY < rect.svgY + rect.svgHeight &&
    zone.svgY + zone.svgHeight > rect.svgY
  );
}

/**
 * Filter `zones` to those that overlap `rect`.
 *
 * Returns an empty array when:
 *   - `zones` is null/undefined (guard)
 *   - the rect is degenerate: either dimension is strictly less than `minPx`
 *
 * Zones with missing or non-numeric coordinate fields are silently skipped
 * rather than throwing so malformed API data never crashes the editor.
 *
 * @param zones   Zone list (may be null/undefined or contain partial objects).
 * @param rect    The normalised selection rectangle in SVG user units.
 * @param minPx   Minimum size (both dimensions) to skip degenerate drags. Default 0.
 */
export function hitTestZones<T extends Partial<ZoneRect>>(
  zones: T[] | null | undefined,
  rect: ZoneRect,
  minPx = 0,
): T[] {
  if (!zones) return [];
  if (rect.svgWidth < minPx || rect.svgHeight < minPx) return [];
  return zones.filter((z): boolean => {
    if (
      typeof z.svgX !== "number" ||
      typeof z.svgY !== "number" ||
      typeof z.svgWidth !== "number" ||
      typeof z.svgHeight !== "number"
    ) {
      return false;
    }
    return aabbIntersects(z as ZoneRect, rect);
  });
}
