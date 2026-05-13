import { pgTable, text, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const misspellingMapTable = pgTable("misspelling_map", {
  id: serial("id").primaryKey(),
  misspelling: text("misspelling").notNull().unique(),
  correction: text("correction").notNull(),
});

export const insertMisspellingMapSchema = createInsertSchema(
  misspellingMapTable,
).omit({ id: true });
export type InsertMisspellingMap = z.infer<typeof insertMisspellingMapSchema>;
export type MisspellingMap = typeof misspellingMapTable.$inferSelect;
