import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const quickLookupCacheTable = pgTable("quick_lookup_cache", {
  label: text("label").primaryKey(),
  answer: text("answer").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type QuickLookupCache = typeof quickLookupCacheTable.$inferSelect;
