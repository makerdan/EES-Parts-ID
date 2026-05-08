import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const productSeriesTable = pgTable('product_series', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  vendor: text('vendor').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type ProductSeries = typeof productSeriesTable.$inferSelect;
export type InsertProductSeries = typeof productSeriesTable.$inferInsert;
