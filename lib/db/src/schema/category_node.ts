/**
 * `category_node` — the three-level taxonomy tree
 * (category → subcategory → type). Slugs are globally unique by DB
 * constraint so `/categories/{slug}/items` always resolves to a
 * single node without having to disambiguate by parent.
 */
import { pgTable, text, serial, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod/v4';

/**
 * Three-level taxonomy node table.
 *
 * Levels:
 *   - "category"    → top level (parentId = null)
 *   - "subcategory" → second level (parent is a category)
 *   - "type"        → leaf level (parent is a subcategory)
 *
 * Slugs are unique across the whole table — this lets us address any node
 * directly by `/categories/:slug/items` without disambiguating the level.
 */
export const categoryNodeTable = pgTable(
  'category_node',
  {
    id: serial('id').primaryKey(),
    parentId: integer('parent_id'),
    level: text('level').notNull(), // "category" | "subcategory" | "type"
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    source: text('source').notNull().default('seed'), // "seed" | "ai" | "manual"
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('category_node_slug_idx').on(table.slug),
    index('category_node_parent_idx').on(table.parentId),
    index('category_node_level_idx').on(table.level),
  ]
);

export const insertCategoryNodeSchema = createInsertSchema(categoryNodeTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCategoryNode = z.infer<typeof insertCategoryNodeSchema>;
export type CategoryNode = typeof categoryNodeTable.$inferSelect;
