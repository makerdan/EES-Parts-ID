import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const descriptionExpansionJobTable = pgTable("description_expansion_job", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("running"),
  cursor: integer("cursor").notNull().default(0),
  model: text("model"),
  ownerId: text("owner_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  total: integer("total"),
  processed: integer("processed").notNull().default(0),
  saved: integer("saved").notNull().default(0),
  discarded: integer("discarded").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  errorMessage: text("error_message"),
}, (table) => [
  index("description_expansion_job_status_id_idx").on(table.status, table.id),
]);

export type DescriptionExpansionJobRecord = typeof descriptionExpansionJobTable.$inferSelect;