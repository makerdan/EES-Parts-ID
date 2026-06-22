import { jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const partCardCacheTable = pgTable("part_card_cache", {
  id: serial("id").primaryKey(),
  catalogKey: text("catalog_key").unique().notNull(),
  data: jsonb("data").notNull(),
  cachedAt: timestamp("cached_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PartCardCache = typeof partCardCacheTable.$inferSelect;
