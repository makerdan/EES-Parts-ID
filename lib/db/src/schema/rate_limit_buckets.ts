import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const rateLimitBucketsTable = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    timestamps: bigint("timestamps", { mode: "number" }).array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("rate_limit_buckets_updated_at_idx").on(t.updatedAt)],
);

export type RateLimitBucket = typeof rateLimitBucketsTable.$inferSelect;
