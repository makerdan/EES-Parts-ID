import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const screenViewLogTable = pgTable("screen_view_log", {
  id: serial("id").primaryKey(),
  screenName: text("screen_name").notNull(),
  visitorHash: text("visitor_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ScreenViewLog = typeof screenViewLogTable.$inferSelect;
