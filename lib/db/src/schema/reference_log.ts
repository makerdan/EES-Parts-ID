import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const referenceLogTable = pgTable("reference_log", {
  id: serial("id").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  matchedItemCount: integer("matched_item_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ReferenceLog = typeof referenceLogTable.$inferSelect;
