import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { usersTable } from "./users";

export type UserHistoryViewedEntry = {
  id: number;
  catalog: string;
  name: string;
  vendor: string;
  timestamp: string;
};

export type UserHistoryScanEntry = {
  barcode: string;
  found: boolean;
  itemId?: number;
  catalog?: string;
  vendor?: string;
  timestamp: string;
  adminAction?: "linked" | "created";
};

export const userHistoryTable = pgTable("user_history", {
  clerkUserId: text("clerk_user_id")
    .primaryKey()
    .references(() => usersTable.clerkUserId, { onDelete: "cascade" }),
  queryHistory: jsonb("query_history")
    .$type<Array<string>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  viewedHistory: jsonb("viewed_history")
    .$type<Array<UserHistoryViewedEntry>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  scanHistory: jsonb("scan_history")
    .$type<Array<UserHistoryScanEntry>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type UserHistory = typeof userHistoryTable.$inferSelect;