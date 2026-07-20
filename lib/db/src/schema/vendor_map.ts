import { sql } from "drizzle-orm";
import { boolean,pgTable, serial, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vendorMapTable = pgTable("vendor_map", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  names: text("names")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  notes: text("notes").notNull().default(""),
  isPrimary: boolean("is_primary").notNull().default(false),
});

export const insertVendorMapSchema = createInsertSchema(vendorMapTable).omit({
  id: true,
});
export type InsertVendorMap = z.infer<typeof insertVendorMapSchema>;
export type VendorMap = typeof vendorMapTable.$inferSelect;
