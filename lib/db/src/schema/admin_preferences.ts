import { pgTable, text, timestamp, integer, boolean, bigint } from "drizzle-orm/pg-core";

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
  revokedBefore: bigint("revoked_before", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
