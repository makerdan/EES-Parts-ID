/**
 * Enrichment audit trail.
 *
 * Two tables:
 *
 *   inventory_enrichment_run     — one row per /apply call (one PDF upload).
 *                                  Carries vendor, source filename, summary
 *                                  counts, and a `reverted_at` marker so we
 *                                  can grey out reverted runs in the UI.
 *
 *   inventory_enrichment_history — one row per inventory mutation in a run.
 *                                  Stores BOTH the before- and after- values
 *                                  for description and aiKeywords so revert
 *                                  is a straight `UPDATE inventory SET … =
 *                                  before_*`. Each row also carries the
 *                                  catalog number from the PDF entry that
 *                                  drove the change for surface-level audit.
 *
 * The catalog-PDF apply route writes a history row inside the same
 * transaction as the inventory UPDATE (per inventory row), so we never end
 * up with an applied change that has no audit row, or vice-versa. Revert
 * runs every per-row restore inside a single outer transaction so a partial
 * revert can never leave half a run rolled back.
 */
import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { inventoryTable } from "./inventory";

export const enrichmentRunTable = pgTable(
  "inventory_enrichment_run",
  {
    id: serial("id").primaryKey(),
    vendor: text("vendor").notNull(),
    sourceFilename: text("source_filename"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    updatedCount: integer("updated_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    revertedAt: timestamp("reverted_at"),
  },
  (table) => [
    index("enrichment_run_started_at_idx").on(table.startedAt),
  ],
);

export const enrichmentHistoryTable = pgTable(
  "inventory_enrichment_history",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => enrichmentRunTable.id, { onDelete: "cascade" }),
    inventoryId: integer("inventory_id")
      .notNull()
      .references(() => inventoryTable.id, { onDelete: "cascade" }),
    catalogNumber: text("catalog_number").notNull(),
    beforeDescription: text("before_description").notNull(),
    afterDescription: text("after_description").notNull(),
    beforeKeywords: text("before_keywords")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    afterKeywords: text("after_keywords")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("enrichment_history_run_id_idx").on(table.runId),
    index("enrichment_history_inventory_id_idx").on(table.inventoryId),
  ],
);

export type EnrichmentRun = typeof enrichmentRunTable.$inferSelect;
export type EnrichmentHistory = typeof enrichmentHistoryTable.$inferSelect;
