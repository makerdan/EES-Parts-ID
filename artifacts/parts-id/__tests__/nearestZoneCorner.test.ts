/**
 * Tests for findNearestZoneCorner — auto-suggesting world coordinates from
 * the nearest zone corner when a calibration anchor is placed.
 */
import type { ApiWarehouseZone, ZoneAlignment } from "@/hooks/useWarehouseZones";
import { DEFAULT_SNAP_DISTANCE, findNearestZoneCorner } from "@/utils/nearestZoneCorner";

const IDENTITY: ZoneAlignment = { translateX: 0, translateY: 0, scale: 1 };

function zone(partial: Partial<ApiWarehouseZone> & { id: number }): ApiWarehouseZone {
  return {
    aisleId: "A",
    sectionNum: 1,
    isInventory: true,
    svgX: 0,
    svgY: 0,
    svgWidth: 100,
    svgHeight: 100,
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
    ...partial,
  };
}

describe("findNearestZoneCorner", () => {
  it("returns null when no zones are given", () => {
    expect(findNearestZoneCorner({ x: 10, y: 10 }, [], IDENTITY)).toBeNull();
  });

  it("matches the nearest corner among all four corners of a zone", () => {
    const z = zone({ id: 1, svgX: 100, svgY: 200, svgWidth: 50, svgHeight: 40 });
    // Near the bottom-right corner (150, 240)
    const m = findNearestZoneCorner({ x: 155, y: 245 }, [z], IDENTITY);
    expect(m).not.toBeNull();
    expect(m!.worldX).toBe(150);
    expect(m!.worldY).toBe(240);
    expect(m!.zone.id).toBe(1);
    expect(m!.distance).toBeCloseTo(Math.hypot(5, 5));
  });

  it("returns null when the nearest corner is beyond maxDistance", () => {
    const z = zone({ id: 1, svgX: 0, svgY: 0, svgWidth: 10, svgHeight: 10 });
    expect(findNearestZoneCorner({ x: 500, y: 500 }, [z], IDENTITY, 100)).toBeNull();
  });

  it("respects a custom maxDistance", () => {
    const z = zone({ id: 1, svgX: 0, svgY: 0, svgWidth: 10, svgHeight: 10 });
    expect(findNearestZoneCorner({ x: 15, y: 10 }, [z], IDENTITY, 4)).toBeNull();
    expect(findNearestZoneCorner({ x: 15, y: 10 }, [z], IDENTITY, 6)).not.toBeNull();
  });

  it("picks the closest corner across multiple zones", () => {
    const z1 = zone({ id: 1, svgX: 0, svgY: 0, svgWidth: 10, svgHeight: 10 });
    const z2 = zone({ id: 2, svgX: 30, svgY: 0, svgWidth: 10, svgHeight: 10 });
    const m = findNearestZoneCorner({ x: 28, y: 0 }, [z1, z2], IDENTITY);
    expect(m!.zone.id).toBe(2);
    expect(m!.worldX).toBe(30);
    expect(m!.worldY).toBe(0);
  });

  it("projects corners through the zone alignment before measuring distance, but returns raw zone-space values", () => {
    const z = zone({ id: 1, svgX: 100, svgY: 100, svgWidth: 50, svgHeight: 50 });
    const alignment: ZoneAlignment = { translateX: 20, translateY: -10, scale: 2 };
    // Corner (100,100) projects to (220, 190) in SVG space.
    const m = findNearestZoneCorner({ x: 222, y: 191 }, [z], alignment, 10);
    expect(m).not.toBeNull();
    expect(m!.worldX).toBe(100);
    expect(m!.worldY).toBe(100);
    // Without alignment awareness, (222,191) would be nowhere near (100,100)
    // in raw zone space — verify the projected distance is what's measured.
    expect(m!.distance).toBeCloseTo(Math.hypot(2, 1));
  });

  it("returns null for a non-positive or non-finite alignment scale", () => {
    const z = zone({ id: 1 });
    expect(findNearestZoneCorner({ x: 0, y: 0 }, [z], { translateX: 0, translateY: 0, scale: 0 })).toBeNull();
    expect(findNearestZoneCorner({ x: 0, y: 0 }, [z], { translateX: 0, translateY: 0, scale: NaN })).toBeNull();
  });

  it("uses DEFAULT_SNAP_DISTANCE when maxDistance is omitted", () => {
    const z = zone({ id: 1, svgX: 0, svgY: 0, svgWidth: 10, svgHeight: 10 });
    const justInside = findNearestZoneCorner({ x: DEFAULT_SNAP_DISTANCE - 1, y: 0 }, [z], IDENTITY);
    const justOutside = findNearestZoneCorner({ x: DEFAULT_SNAP_DISTANCE + 20, y: 0 }, [z], IDENTITY);
    expect(justInside).not.toBeNull();
    expect(justOutside).toBeNull();
  });
});
