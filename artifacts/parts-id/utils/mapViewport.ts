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

/** Minimal zone geometry used by the focus-pan handler. */
export interface ZoneGeometry {
  aisleId: string;
  sectionNum: number;
  svgX: number;
  svgY: number;
  svgWidth: number;
  svgHeight: number;
}

/**
 * Exported for testing: pure function containing the pan-without-zoom logic
 * extracted from the `focusAisleNum` useEffect in WarehouseMapView.
 *
 * Takes the current viewport values as plain numbers (not SharedValue objects)
 * so tests can call it without any Reanimated setup.  The effect passes
 * `scale.value`, `translateX.value`, `translateY.value` as arguments and
 * applies the returned `{tx,ty}` with `withSpring` — crucially, `scale` is
 * never written.
 *
 * Returns `{tx, ty}` when a pan is needed, or `null` when the zone is already
 * visible or cannot be found.
 *
 * Contract: the return object contains ONLY `tx` and `ty` — no `scale` field.
 * A regression that reintroduced forced zooming would be caught immediately
 * by the test suite (`focusAislePan.test.ts`).
 *
 * When `focusSectionNum` is provided the function first tries to find the zone
 * that matches both the aisle and the section; if no such zone exists it falls
 * back to the first zone in the aisle so the map still pans to a sensible
 * location rather than doing nothing.
 */
export function runFocusAisleEffect(opts: {
  focusAisleNum: number;
  /** When set, the map centres on the specific section zone instead of the first aisle zone. */
  focusSectionNum?: number;
  zones: ReadonlyArray<ZoneGeometry>;
  containerW: number;
  containerH: number;
  /** The current zoom level — read to compute pan offset; never changed. */
  currentScale: number;
  currentTX: number;
  currentTY: number;
}): { tx: number; ty: number } | null {
  const { focusAisleNum, focusSectionNum, zones, containerW, containerH, currentScale, currentTX, currentTY } = opts;
  if (containerW === 0 || containerH === 0 || !zones.length) return null;

  const aisleZones = zones.filter(z => parseInt(z.aisleId, 10) === focusAisleNum);
  const zone =
    focusSectionNum != null
      ? (aisleZones.find(z => z.sectionNum === focusSectionNum) ?? aisleZones[0])
      : aisleZones[0];
  if (!zone) return null;

  const cx = zone.svgX + zone.svgWidth  / 2;
  const cy = zone.svgY + zone.svgHeight / 2;

  const svgRW   = containerW;
  const svgRH   = containerW / SVG_ASPECT;
  const scaleRW = (1 / SVG_VIEWBOX_W) * svgRW * currentScale;
  const scaleRH = (1 / SVG_VIEWBOX_H) * svgRH * currentScale;
  const zoneL   = zone.svgX                    * scaleRW + currentTX;
  const zoneR   = (zone.svgX + zone.svgWidth)  * scaleRW + currentTX;
  const zoneT   = zone.svgY                    * scaleRH + currentTY;
  const zoneB   = (zone.svgY + zone.svgHeight) * scaleRH + currentTY;

  if (zoneR > 0 && zoneL < containerW && zoneB > 0 && zoneT < containerH) return null;

  // Return pan target — scale is deliberately absent: focus only pans, never zooms.
  return computeFocusPan(currentScale, cx, cy, containerW, containerH);
}

/**
 * Compute the translation offsets needed to pan the viewport so that a zone
 * (identified by its centre in SVG coordinates) is centred in the container.
 *
 * This mirrors the pan-without-zoom logic inside the `focusAisleNum` effect of
 * WarehouseMapView: the caller's current `scale` value is used as-is — this
 * function never modifies or returns a new scale.
 *
 * Returned `tx` / `ty` are the new `translateX.value` / `translateY.value`
 * to apply (e.g. via withSpring) after the calculation.
 */
export function computeFocusPan(
  currentScale: number,
  zoneCx: number,
  zoneCy: number,
  containerW: number,
  containerH: number,
): { tx: number; ty: number } {
  const svgRW = containerW;
  const svgRH = containerW / SVG_ASPECT;
  const scaleRW = (1 / SVG_VIEWBOX_W) * svgRW * currentScale;
  const scaleRH = (1 / SVG_VIEWBOX_H) * svgRH * currentScale;
  return {
    tx: containerW / 2 - zoneCx * scaleRW,
    ty: containerH / 2 - zoneCy * scaleRH,
  };
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
 * The SVG renders at containerW × svgRenderH points.  At a given scale the
 * rendered area grows by that factor.  Each axis allows panning up to half
 * the overflow past the container edge (because the transform pivots around
 * the view centre).  When the scaled map is smaller than the container on an
 * axis — i.e. in the "letterboxed" portrait case for Y — that axis returns 0
 * and no panning is permitted.
 *
 * `svgRenderH` must reflect the ACTUAL floor-plan viewBox aspect ratio
 * (containerW / (contentVB.w / contentVB.h)), falling back to
 * containerW / SVG_ASPECT before the viewBox is parsed.
 *
 * Returns { maxX, maxY } — always ≥ 0.
 */
export function panBounds(
  containerW: number,
  containerH: number,
  scale: number,
  svgRenderH: number,
): { maxX: number; maxY: number } {
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
 *
 * @deprecated Use zoomStopForScale + tileGridSize for the discrete-stop system.
 */
export function numTilesForScale(scale: number): number {
  return Math.ceil(scale);
}

// ── Discrete zoom-stop pyramid ────────────────────────────────────────────────
// Five preset zoom levels map to z-levels 0–4.  At each level the tile grid
// is 2^z × 2^z (1×1 at z0 through 16×16 at z4).  The client springs to the
// nearest stop when a pinch gesture ends; buttons step one stop at a time.

export interface ZoomStop {
  /** Zoom level index 0–4 (z0 = overview, z4 = bin). */
  z: number;
  /** Target scale value for this stop. */
  scale: number;
  /** Human-readable label for the zoom level. */
  label: string;
}

/**
 * Five preset zoom stops covering overview → aisle → section → shelf → bin.
 * Scale values are chosen so each stop feels meaningfully different and the
 * overview stop (z0) is close to the default fit-to-content scale (~1.5×).
 */
export const ZOOM_STOPS: ReadonlyArray<ZoomStop> = [
  { z: 0, scale: 1.5,  label: "overview" },
  { z: 1, scale: 4,    label: "aisle"    },
  { z: 2, scale: 10,   label: "section"  },
  { z: 3, scale: 22,   label: "shelf"    },
  { z: 4, scale: 45,   label: "bin"      },
];

/**
 * Tile grid dimension for zoom level z: 2^z.
 * z0 → 1×1, z1 → 2×2, z2 → 4×4, z3 → 8×8, z4 → 16×16.
 */
export function tileGridSize(z: number): number {
  return Math.pow(2, z);
}

/**
 * Return the index into ZOOM_STOPS nearest to `scale` using log-distance so
 * that stops feel equally spaced when zooming in/out perceptually.
 * Always returns a value in [0, ZOOM_STOPS.length − 1].
 */
export function zoomStopForScale(scale: number): number {
  const logS = Math.log(Math.max(0.001, scale));
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ZOOM_STOPS.length; i++) {
    const d = Math.abs(logS - Math.log(ZOOM_STOPS[i].scale));
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/**
 * Compute the snapped fit-to-content viewport target shared by `applyFit`
 * (animated) and `applyFitIfReady` (immediate) in WarehouseMapView.
 *
 * Both callbacks call `fitContentViewport` to derive the raw geometry, then
 * override the scale to `ZOOM_STOPS[0].scale` (z0 overview) so the fit button
 * always snaps to the same discrete zoom level regardless of container size.
 * The tx/ty are re-proportioned to match the snapped scale.
 *
 * Extracting this as a pure function lets tests exercise the real path without
 * mounting WarehouseMapView or mocking Reanimated.
 */
export function computeFitTarget(
  vb: ContentViewBox,
  containerW: number,
  containerH: number,
): { scale: number; tx: number; ty: number } {
  const { scale: rawS, tx: rawTX, ty: rawTY } = fitContentViewport(
    vb, containerW, containerH, SVG_VIEWBOX_W, SVG_VIEWBOX_H,
  );
  const s = ZOOM_STOPS[0].scale;
  const ratio = rawS > 0 ? s / rawS : 1;
  return { scale: s, tx: rawTX * ratio, ty: rawTY * ratio };
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
