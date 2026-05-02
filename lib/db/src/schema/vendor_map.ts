/**
 * `vendor_map` — short vendor codes (e.g. "ETN") to full vendor names
 * (e.g. "Eaton"). Lets workers type either form when searching.
 */
import { pgTable, text, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const vendorMapTable = pgTable("vendor_map", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  names: text("names")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  notes: text("notes").notNull().default(""),
});

export const insertVendorMapSchema = createInsertSchema(vendorMapTable).omit({
  id: true,
});
export type InsertVendorMap = z.infer<typeof insertVendorMapSchema>;
export type VendorMap = typeof vendorMapTable.$inferSelect;
