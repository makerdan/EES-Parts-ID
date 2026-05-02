/**
 * `synonym_map` — equivalent terms used interchangeably on the floor
 * (e.g. "breaker" ↔ "circuit breaker"). Used to expand search queries.
 */
import { pgTable, text, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const synonymMapTable = pgTable("synonym_map", {
  id: serial("id").primaryKey(),
  term: text("term").notNull().unique(),
  synonyms: text("synonyms")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  category: text("category").notNull().default(""),
});

export const insertSynonymMapSchema = createInsertSchema(synonymMapTable).omit({
  id: true,
});
export type InsertSynonymMap = z.infer<typeof insertSynonymMapSchema>;
export type SynonymMap = typeof synonymMapTable.$inferSelect;
