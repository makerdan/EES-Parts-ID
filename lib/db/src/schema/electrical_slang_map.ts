import { sql } from "drizzle-orm";
import { pgTable, serial,text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const electricalSlangMapTable = pgTable("electrical_slang_map", {
  id: serial("id").primaryKey(),
  slangTerm: text("slang_term").notNull().unique(),
  standardTerms: text("standard_terms")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  category: text("category").notNull().default(""),
  notes: text("notes").notNull().default(""),
});

export const insertElectricalSlangMapSchema = createInsertSchema(
  electricalSlangMapTable,
).omit({ id: true });
export type InsertElectricalSlangMap = z.infer<
  typeof insertElectricalSlangMapSchema
>;
export type ElectricalSlangMap = typeof electricalSlangMapTable.$inferSelect;
