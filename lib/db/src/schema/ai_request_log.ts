import { pgEnum, pgTable, serial, timestamp } from "drizzle-orm/pg-core";

export const aiFeatureEnum = pgEnum("ai_feature", ["identify", "reference"]);

export const aiRequestLogTable = pgTable("ai_request_log", {
  id: serial("id").primaryKey(),
  feature: aiFeatureEnum("feature").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AiRequestLog = typeof aiRequestLogTable.$inferSelect;
