/**
 * `synonym_group` — one row per canonical electrical term; the `synonyms`
 * array lists all equivalent forms workers might use (trade slang, vendor
 * aliases, abbreviations, etc.).
 *
 * Used at enrichment time by `buildSearchTokens()` to expand inventory
 * rows so trigram search can match any equivalent form without paying a
 * per-request table-load cost.
 *
 * Expansion is bidirectional: a row whose description contains "romex"
 * and a row whose description contains "nm-b" both get every group
 * member added to `search_tokens`, so either query term finds both.
 */
import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const synonymGroupTable = pgTable("synonym_group", {
  id: serial("id").primaryKey(),
  canonical: text("canonical").notNull().unique(),
  synonyms: text("synonyms")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  categoryHint: text("category_hint"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSynonymGroupSchema = createInsertSchema(synonymGroupTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertSynonymGroup = z.infer<typeof insertSynonymGroupSchema>;
export type SynonymGroup = typeof synonymGroupTable.$inferSelect;
