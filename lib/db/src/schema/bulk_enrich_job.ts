import { boolean, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const bulkEnrichJobTable = pgTable("bulk_enrich_job", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("running"),
  force: boolean("force").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  processed: integer("processed").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  total: integer("total"),
  errorMessage: text("error_message"),
  model: text("model"),
}, (table) => [
  // Bulk-enrichment recovery reads the newest terminal result and retention
  // deletes older terminal history. Keep that scan index-backed.
  index("bulk_enrich_job_status_id_idx").on(table.status, table.id),
]);

export type BulkEnrichJobRecord = typeof bulkEnrichJobTable.$inferSelect;