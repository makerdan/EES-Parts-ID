import { pgTable, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

export const adminPreferencesTable = pgTable("admin_preferences", {
  id: integer("id").primaryKey().default(1),
  dimensionUnit: text("dimension_unit").notNull().default("mm"),
  textSize: text("text_size").notNull().default("normal"),
  themeMode: text("theme_mode").notNull().default("system"),
  defaultConfidenceThreshold: integer("default_confidence_threshold").notNull().default(50),
  scanSound: boolean("scan_sound").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
