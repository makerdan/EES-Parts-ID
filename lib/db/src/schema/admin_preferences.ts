import { bigint, boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const adminPreferencesTable = pgTable("admin_preferences", {
  id: integer("id").primaryKey().default(1),
  dimensionUnit: text("dimension_unit").notNull().default("mm"),
  textSize: text("text_size").notNull().default("normal"),
  themeMode: text("theme_mode").notNull().default("system"),
  defaultConfidenceThreshold: integer("default_confidence_threshold").notNull().default(50),
  scanSound: boolean("scan_sound").notNull().default(true),
  shelfPrefix: text("shelf_prefix"),
  shelfStep: integer("shelf_step"),
  aiProvider: text("ai_provider"),
  aiFallbackModels: jsonb("ai_fallback_models").$type<Record<string, Array<string>>>(),
  // Global zone-layer alignment calibration applied uniformly to every zone on
  // the Map tab (translate in SVG units + uniform scale). Defaults to identity.
  zoneAlignX: doublePrecision("zone_align_x").notNull().default(0),
  zoneAlignY: doublePrecision("zone_align_y").notNull().default(0),
  zoneAlignScale: doublePrecision("zone_align_scale").notNull().default(1),
  revokedBefore: bigint("revoked_before", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
