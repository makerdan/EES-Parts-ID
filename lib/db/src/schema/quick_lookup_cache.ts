/**
 * `quick_lookup_cache` — pre-generated AI answers for the 12 canonical
 * Quick Lookup chips in the Reference modal. Each row stores the chip
 * label, the question text, the full answer, and when it was last
 * refreshed so the seeder can skip rows newer than 30 days.
 */
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod/v4';

export const quickLookupCache = pgTable('quick_lookup_cache', {
  id: serial('id').primaryKey(),
  label: text('label').notNull().unique(),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).defaultNow().notNull(),
});

export const insertQuickLookupCacheSchema = createInsertSchema(quickLookupCache).omit({
  id: true,
  refreshedAt: true,
});

export type QuickLookupCache = typeof quickLookupCache.$inferSelect;
export type InsertQuickLookupCache = z.infer<typeof insertQuickLookupCacheSchema>;
