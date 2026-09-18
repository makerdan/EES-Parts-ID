/**
 * nearestZoneCorner — finds the zone corner closest to a tapped floor-plan
 * point, so the calibration screen can pre-fill world (zone-space)
 * coordinates.
 *
 * Zones live in zone-space; the floor-plan tap is in SVG viewBox space.
 * The two are related by the ZoneAlignment transform
 * (svg = zone * scale + translate), so each corner is projected into SVG
 * space before measuring distance. The returned coordinates are the raw
 * zone-space corner values (what the admin would otherwise type in).
 */
import type { ApiWarehouseZone, ZoneAlignment } from "@/hooks/useWarehouseZones";

/** Max distance (in SVG viewBox units) at which a corner is considered "nearby". */
export const DEFAULT_SNAP_DISTANCE = 150;

export interface ZoneCornerMatch {
  /** Zone-space X of the matched corner (value for the "Zone X" field). */
  worldX: number;
  /** Zone-space Y of the matched corner (value for the "Zone Y" field). */
  worldY: number;
  /** Distance from the tap to the corner, in SVG viewBox units. */
  distance: number;
  /** The zone the corner belongs to. */
  zone: ApiWarehouseZone;
}

/**
 * Returns the nearest zone corner within `maxDistance` (SVG units) of the
 * tapped SVG point, or null when no corner is close enough.
 */
export function findNearestZoneCorner(
  svgPt: { x: number; y: number },
  zones: ReadonlyArray<ApiWarehouseZone>,
  alignment: ZoneAlignment,
  maxDistance: number = DEFAULT_SNAP_DISTANCE,
): ZoneCornerMatch | null {
  const { translateX, translateY, scale } = alignment;
  if (!Number.isFinite(scale) || scale <= 0) return null;

  let best: ZoneCornerMatch | null = null;
  for (const zone of zones) {
    const xs = [zone.svgX, zone.svgX + zone.svgWidth];
    const ys = [zone.svgY, zone.svgY + zone.svgHeight];
    for (const wx of xs) {
      for (const wy of ys) {
        // Project the zone-space corner into SVG viewBox space.
        const sx = wx * scale + translateX;
        const sy = wy * scale + translateY;
        const distance = Math.hypot(svgPt.x - sx, svgPt.y - sy);
        if (distance <= maxDistance && (best === null || distance < best.distance)) {
          best = { worldX: wx, worldY: wy, distance, zone };
        }
      }
    }
  }
  return best;
}
