import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const adminPreferencesTable = pgTable("admin_preferences", {
  id: integer("id").primaryKey().default(1),
  dimensionUnit: text("dimension_unit").notNull().default("mm"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
