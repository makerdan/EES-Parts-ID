import {
  pgTable,
  text,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const inventoryTable = pgTable(
  "inventory",
  {
    id: serial("id").primaryKey(),
    vendor: text("vendor").notNull(),
    catalog: text("catalog").notNull(),
    description: text("description").notNull().default(""),
    binLocations: text("bin_locations")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    aiKeywords: text("ai_keywords")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    enrichedAt: timestamp("enriched_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("inventory_vendor_catalog_idx").on(table.vendor, table.catalog),
  ],
);

export const insertInventorySchema = createInsertSchema(inventoryTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type Inventory = typeof inventoryTable.$inferSelect;
