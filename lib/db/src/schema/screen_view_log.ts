import { index, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const screenViewLogTable = pgTable(
  "screen_view_log",
  {
    id: serial("id").primaryKey(),
    screenName: text("screen_name").notNull(),
    // Nullable by design: unique-visitor reporting is disabled when the
    // server has no suitable keyed material. No client identifier is stored.
    visitorHash: text("visitor_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    createdAtIdx: index("screen_view_log_created_at_idx").on(table.createdAt),
    screenNameCreatedAtIdx: index("screen_view_log_screen_name_created_at_idx").on(
      table.screenName,
      table.createdAt,
    ),
  }),
);

export type ScreenViewLog = typeof screenViewLogTable.$inferSelect;
