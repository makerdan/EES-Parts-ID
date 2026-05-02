/**
 * `abbreviation_map` — maps short electrical abbreviations (e.g.
 * "GFCI") to their expanded form. Powers the Reference modal lookup.
 */
import { pgTable, text, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const abbreviationMapTable = pgTable("abbreviation_map", {
  id: serial("id").primaryKey(),
  abbreviation: text("abbreviation").notNull().unique(),
  expansions: text("expansions")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  category: text("category").notNull().default(""),
});

export const insertAbbreviationMapSchema = createInsertSchema(
  abbreviationMapTable,
).omit({ id: true });
export type InsertAbbreviationMap = z.infer<typeof insertAbbreviationMapSchema>;
export type AbbreviationMap = typeof abbreviationMapTable.$inferSelect;
