import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const measureEnrichJobTable = pgTable("measure_enrich_job", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  processed: integer("processed").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  errorMessage: text("error_message"),
});

export type MeasureEnrichJobRecord = typeof measureEnrichJobTable.$inferSelect;
