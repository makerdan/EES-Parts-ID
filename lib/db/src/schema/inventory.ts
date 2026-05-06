/**
 * Core `inventory` table — one row per part SKU.
 *
 * `binLocations` is a text[] of free-form codes (typically `AA-SS-SHP`,
 * but the warehouse has historical non-conforming codes too — see
 * `lib/aisleHierarchy.ts` for the parser that tolerates both).
 * `aiKeywords` is the AI-enriched keyword list used by the trigram
 * search to match worker queries against electrical jargon.
 *
 * The table also has a generated column `search_tsv tsvector STORED` added by
 * migration 0009_fts_weighted.sql. It is not declared here because Drizzle's
 * pg-core does not yet support GENERATED ALWAYS AS tsvector columns, but it is
 * used directly in raw SQL via `i.search_tsv` in the inventory search route.
 * Weight classes: A=catalog (simple), B=vendor (simple), C=description (english),
 * D=ai_keywords (english). GIN index: idx_inventory_search_tsv.
 *
 * Materialized parse columns (added by migration 0010_materialized_attrs.sql):
 *   catalogParse   — parseCatalog() output {series, poles, amps, variant, raw, parser_version}
 *   amperage       — integer amperage extracted from catalog or description
 *   poleCount      — smallint pole count (1–4)
 *   voltage        — integer voltage rating
 *   tradeSizeIn    — numeric(6,3) trade size in decimal inches
 *   mountType      — bolt-on | plug-in | din-rail | surface | flush
 *   attrsParsedAt  — when the parse attrs were last computed (NULL = needs backfill)
 *   promptVersion  — AI prompt version used when enrichedAt was set
 */
import {
  pgTable,
  text,
  serial,
  integer,
  smallint,
  numeric,
  timestamp,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const inventoryTable = pgTable(
  "inventory",
  {
    id: serial("id").primaryKey(),
    vendor: text("vendor").notNull(),
    catalog: text("catalog").notNull(),
    description: text("description").notNull().default(""),
    binLocations: text("bin_locations")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    aiKeywords: text("ai_keywords")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    tradeSize: text("trade_size"),
    enrichedAt: timestamp("enriched_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // ── Materialized parse columns (migration 0010) ──────────────────────────
    catalogParse: jsonb("catalog_parse"),
    amperage: integer("amperage"),
    poleCount: smallint("pole_count"),
    voltage: integer("voltage"),
    tradeSizeIn: numeric("trade_size_in", { precision: 6, scale: 3 }),
    mountType: text("mount_type"),
    attrsParsedAt: timestamp("attrs_parsed_at"),
    promptVersion: smallint("prompt_version"),
  },
  (table) => [
    uniqueIndex("inventory_vendor_catalog_idx").on(table.vendor, table.catalog),
  ],
);

export const insertInventorySchema = createInsertSchema(inventoryTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type Inventory = typeof inventoryTable.$inferSelect;
