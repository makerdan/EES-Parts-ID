import { sql } from "drizzle-orm";
import { pgTable, serial,text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

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
