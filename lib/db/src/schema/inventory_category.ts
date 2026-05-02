import {
  pgTable,
  integer,
  timestamp,
  text,
  numeric,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Assignment of an inventory item to a single category_node (the leaf
 * "type" node when one was found, otherwise the highest level the
 * classifier could place it at).
 *
 * One row per (inventory_id, category_node_id). An inventory item MAY have
 * multiple rows when the classifier finds it fits more than one type — in
 * practice the classifier currently picks a single best match per item.
 */
export const inventoryCategoryTable = pgTable(
  "inventory_category",
  {
    inventoryId: integer("inventory_id").notNull(),
    categoryNodeId: integer("category_node_id").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 })
      .notNull()
      .default("1.0000"),
    classifiedBy: text("classified_by").notNull().default("rule"), // "rule" | "ai" | "manual"
    classifiedAt: timestamp("classified_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.inventoryId, table.categoryNodeId],
    }),
    index("inventory_category_node_idx").on(table.categoryNodeId),
    index("inventory_category_item_idx").on(table.inventoryId),
  ],
);

export const insertInventoryCategorySchema = createInsertSchema(inventoryCategoryTable).omit({
  classifiedAt: true,
});
export type InsertInventoryCategory = z.infer<typeof insertInventoryCategorySchema>;
export type InventoryCategory = typeof inventoryCategoryTable.$inferSelect;
