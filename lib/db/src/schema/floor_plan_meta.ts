import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const floorPlanMetaTable = pgTable("floor_plan_meta", {
  id: serial("id").primaryKey(),
  objectPath: text("object_path").notNull(),
  hash: text("hash").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
});

export type FloorPlanMeta = typeof floorPlanMetaTable.$inferSelect;
