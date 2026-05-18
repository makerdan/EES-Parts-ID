import {
  pgTable,
  text,
  serial,
  timestamp,
  uniqueIndex,
  boolean,
  real,
  integer,
  check,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const SECTION_PARITY_VALUES = ["odd", "even", "all"] as const;
export type SectionParity = (typeof SECTION_PARITY_VALUES)[number];

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
    enrichedAt: timestamp("enriched_at"),
    // ── PDF catalog enrichment ────────────────────────────────────────────────
    imageUrl: text("image_url"),
    imageSource: text("image_source"),
    imageConfidence: real("image_confidence"),
    previousDescription: text("previous_description"),
    catalogPdfJobId: integer("catalog_pdf_job_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
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

// ── Catalog PDF Job ────────────────────────────────────────────────────────────
export const PDF_JOB_STATUS = ["pending", "processing", "done", "failed"] as const;
export type PdfJobStatus = (typeof PDF_JOB_STATUS)[number];

export const catalogPdfJobTable = pgTable("catalog_pdf_job", {
  id: serial("id").primaryKey(),
  vendor: text("vendor").notNull(),
  filename: text("filename").notNull(),
  status: text("status").notNull().default("pending"),
  totalPages: integer("total_pages"),
  processedPages: integer("processed_pages").notNull().default(0),
  matchedParts: integer("matched_parts").notNull().default(0),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCatalogPdfJobSchema = createInsertSchema(catalogPdfJobTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCatalogPdfJob = z.infer<typeof insertCatalogPdfJobSchema>;
export type CatalogPdfJob = typeof catalogPdfJobTable.$inferSelect;

export const warehouseZoneTable = pgTable(
  "warehouse_zone",
  {
    id: serial("id").primaryKey(),
    aisleId: text("aisle_id").notNull(),
    label: text("label").notNull(),
    sectionParity: text("section_parity").notNull().default("all"),
    isInventory: boolean("is_inventory").notNull().default(true),
    svgX: real("svg_x").notNull(),
    svgY: real("svg_y").notNull(),
    svgWidth: real("svg_width").notNull(),
    svgHeight: real("svg_height").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "warehouse_zone_section_parity_check",
      sql`${table.sectionParity} IN ('odd', 'even', 'all')`,
    ),
  ],
);

export const insertWarehouseZoneSchema = createInsertSchema(warehouseZoneTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWarehouseZone = z.infer<typeof insertWarehouseZoneSchema>;
export type WarehouseZone = typeof warehouseZoneTable.$inferSelect;
