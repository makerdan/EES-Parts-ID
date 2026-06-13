import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const referenceAnswerCacheTable = pgTable("reference_answer_cache", {
  questionHash: text("question_hash").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  cachedAt: timestamp("cached_at", { withTimezone: true }).defaultNow().notNull(),
  usedWebSearch: boolean("used_web_search").default(false).notNull(),
});

export type ReferenceAnswerCache = typeof referenceAnswerCacheTable.$inferSelect;
