import { doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Stores up to 3 named anchor points for the warehouse map affine calibration layer.
 * Each row maps a tapped SVG coordinate (svgX/svgY) to a zone-space coordinate
 * (worldX/worldY). When all 3 are present, WarehouseMapView computes a 6-DOF
 * affine transform to align the zone overlay with the floor-plan SVG.
 *
 * id = slot number 1, 2, or 3 (enforced by API, not DB constraint).
 */
export const mapAnchorPointsTable = pgTable("map_anchor_points", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().default(""),
  svgX: doublePrecision("svg_x").notNull(),
  svgY: doublePrecision("svg_y").notNull(),
  worldX: doublePrecision("world_x").notNull(),
  worldY: doublePrecision("world_y").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
