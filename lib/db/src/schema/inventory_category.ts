/**
 * Mapping table `inventory_category` — links each inventory row to a
 * leaf `category_node`. Stores the assignment `source` (`rule` /
 * `ai` / `manual`) and a confidence score so admins can audit the
 * hybrid classifier's decisions.
 */
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
 * Assignment of an inventory item to a single leaf category_node ("type"
 * level). The PRIMARY KEY is `inventory_id` alone, so the database rejects
 * multi-assignment drift at the schema level — every inventory row maps to
 * exactly one Category → Subcategory → Type path. The classifier and the
 * admin assignment endpoints rely on this invariant.
 *
 * History: prior schema used PK (inventory_id, category_node_id); migration
 * 0004 swapped to PK (inventory_id) after de-duplicating any pre-existing
 * rows.
 *
 * Migration 0013 added reviewed_at and reviewed_by for the admin review queue.
 */
export const inventoryCategoryTable = pgTable(
  "inventory_category",
  {
    inventoryId:    integer("inventory_id").notNull(),
    categoryNodeId: integer("category_node_id").notNull(),
    confidence:     numeric("confidence", { precision: 5, scale: 4 })
      .notNull()
      .default("1.0000"),
    classifiedBy:   text("classified_by").notNull().default("rule"), // "rule" | "ai" | "manual"
    classifiedAt:   timestamp("classified_at").defaultNow().notNull(),
    // ── Review queue columns (migration 0013) ───────────────────────────────
    reviewedAt:     timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy:     text("reviewed_by"),
  },
  (table) => [
    primaryKey({ columns: [table.inventoryId] }),
    index("inventory_category_node_idx").on(table.categoryNodeId),
  ],
);

export const insertInventoryCategorySchema = createInsertSchema(inventoryCategoryTable).omit({
  classifiedAt: true,
});
export type InsertInventoryCategory = z.infer<typeof insertInventoryCategorySchema>;
export type InventoryCategory = typeof inventoryCategoryTable.$inferSelect;
