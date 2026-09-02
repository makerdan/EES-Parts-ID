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

export interface SvgRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SvgBounds {
  w: number;
  h: number;
}

export type ResizeHandle =
  | "nw" | "ne" | "sw" | "se"
  | "n" | "s" | "e" | "w";

export const DEFAULT_GRID_SPACING = 10;
export const MIN_GRID_SPACING = 2;
export const MAX_GRID_SPACING = 200;
export const DEFAULT_STANDARD_RECT = { w: 200, h: 150 } as const;
export const MIN_STANDARD_RECT_SIZE = 8;
export const MAX_STANDARD_RECT_SIZE = 4000;

/** Round a coordinate only when it is close enough to a grid line. */
export function snapCoordinate(
  value: number,
  spacing: number,
  threshold = Math.min(4, spacing / 3),
): number {
  if (!Number.isFinite(value) || !Number.isFinite(spacing) || spacing <= 0) return value;
  const snapped = Math.round(value / spacing) * spacing;
  return Math.abs(snapped - value) <= Math.max(0, threshold) ? snapped : value;
}

function snapPoint(
  point: Pt,
  spacing: number,
  threshold = Math.min(4, spacing / 3),
): Pt {
  return {
    x: snapCoordinate(point.x, spacing, threshold),
    y: snapCoordinate(point.y, spacing, threshold),
  };
}

function clampRectPosition(
  rect: SvgRect,
  bounds: SvgBounds,
): SvgRect {
  const maxX = Math.max(0, bounds.w - rect.w);
  const maxY = Math.max(0, bounds.h - rect.h);
  return {
    ...rect,
    x: Math.min(maxX, Math.max(0, rect.x)),
    y: Math.min(maxY, Math.max(0, rect.y)),
  };
}

/**
 * Clamp a translation so every rectangle in a selection remains inside the
 * floor-plan bounds. This preserves the spacing between selected rectangles.
 */
export function clampDeltaForRects(
  rects: SvgRect[],
  delta: Pt,
  bounds: SvgBounds,
): Pt {
  if (rects.length === 0) return delta;
  let minDeltaX = -Infinity;
  let maxDeltaX = Infinity;
  let minDeltaY = -Infinity;
  let maxDeltaY = Infinity;
  for (const rect of rects) {
    minDeltaX = Math.max(minDeltaX, -rect.x);
    maxDeltaX = Math.min(maxDeltaX, bounds.w - rect.x - rect.w);
    minDeltaY = Math.max(minDeltaY, -rect.y);
    maxDeltaY = Math.min(maxDeltaY, bounds.h - rect.y - rect.h);
  }
  return {
    x: Math.min(maxDeltaX, Math.max(minDeltaX, delta.x)),
    y: Math.min(maxDeltaY, Math.max(minDeltaY, delta.y)),
  };
}

export function moveRect(
  rect: SvgRect,
  position: Pt,
  options: { snap: boolean; spacing: number; bounds?: SvgBounds | undefined },
): SvgRect {
  const snapped = options.snap ? snapPoint(position, options.spacing) : position;
  const moved = { ...rect, x: snapped.x, y: snapped.y };
  return options.bounds ? clampRectPosition(moved, options.bounds) : moved;
}

function clampResizePoint(
  point: Pt,
  handle: ResizeHandle,
  bounds: SvgBounds | undefined,
): Pt {
  if (!bounds) return point;
  return {
    x: handle.includes("w") ? Math.max(0, Math.min(bounds.w, point.x))
      : handle.includes("e") ? Math.max(0, Math.min(bounds.w, point.x))
      : point.x,
    y: handle.includes("n") ? Math.max(0, Math.min(bounds.h, point.y))
      : handle.includes("s") ? Math.max(0, Math.min(bounds.h, point.y))
      : point.y,
  };
}

/**
 * Resize from the pointer while keeping the opposite edge/corner fixed.
 * Minimum sizing is applied after snapping so a snap can never collapse a zone.
 */
export function resizeRect(
  rect: SvgRect,
  handle: ResizeHandle,
  pointer: Pt,
  minSize: number,
  options: { snap: boolean; spacing: number; bounds?: SvgBounds | undefined },
): SvgRect {
  const raw = clampResizePoint(pointer, handle, options.bounds);
  const p = options.snap ? snapPoint(raw, options.spacing) : raw;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const min = Math.max(0, minSize);
  let next = { ...rect };

  if (handle.includes("w")) {
    const x = Math.min(p.x, right - min);
    next = { ...next, x, w: right - x };
  } else if (handle.includes("e")) {
    next.w = Math.max(min, p.x - rect.x);
  }
  if (handle.includes("n")) {
    const y = Math.min(p.y, bottom - min);
    next = { ...next, y, h: bottom - y };
  } else if (handle.includes("s")) {
    next.h = Math.max(min, p.y - rect.y);
  }

  if (options.bounds) {
    next = clampRectPosition(next, options.bounds);
  }
  return next;
}

export function placeStandardRect(
  bounds: SvgBounds,
  size: { w: number; h: number },
  options: { snap: boolean; spacing: number; center?: Pt } = {
    snap: false,
    spacing: DEFAULT_GRID_SPACING,
  },
): SvgRect {
  const w = Math.min(Math.max(MIN_STANDARD_RECT_SIZE, size.w), Math.max(MIN_STANDARD_RECT_SIZE, Math.min(MAX_STANDARD_RECT_SIZE, bounds.w)));
  const h = Math.min(Math.max(MIN_STANDARD_RECT_SIZE, size.h), Math.max(MIN_STANDARD_RECT_SIZE, Math.min(MAX_STANDARD_RECT_SIZE, bounds.h)));
  const center = options.center ?? { x: bounds.w / 2, y: bounds.h / 2 };
  const position = { x: center.x - w / 2, y: center.y - h / 2 };
  return clampRectPosition(
    moveRect({ x: 0, y: 0, w, h }, position, options),
    bounds,
  );
}

export function readBoundedNumber(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return integer ? Math.round(value) : value;
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
