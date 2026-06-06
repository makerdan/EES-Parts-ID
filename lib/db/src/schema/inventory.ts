import {
  pgTable,
  text,
  serial,
  timestamp,
  uniqueIndex,
  index,
  boolean,
  real,
  integer,
  check,
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
    // NOT NULL DEFAULT '{}' is intentional — same contract as binLocations.
    // An empty array means "no barcodes assigned" (not unknown); simplifies
    // array-containment queries and avoids null checks throughout the API.
    barcodes: text("barcodes")
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
    // ── Physical dimensions ──────────────────────────────────────────────────
    // Nullable JSON object: { length?, width?, height?, diameter? } all in mm.
    // Populated via LiDAR scan or manual entry. Kept as jsonb so the schema
    // remains flexible (e.g. future tolerance fields) without another migration.
    dimensions: jsonb("dimensions").$type<{
      length?: number | null;
      width?: number | null;
      height?: number | null;
      diameter?: number | null;
    }>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("inventory_vendor_catalog_idx").on(table.vendor, table.catalog),
    index("inventory_dimensions_length_idx").using(
      "btree",
      sql`((dimensions->>'length')::numeric)`,
    ),
    index("inventory_dimensions_width_idx").using(
      "btree",
      sql`((dimensions->>'width')::numeric)`,
    ),
    index("inventory_dimensions_height_idx").using(
      "btree",
      sql`((dimensions->>'height')::numeric)`,
    ),
    index("inventory_dimensions_diameter_idx").using(
      "btree",
      sql`((dimensions->>'diameter')::numeric)`,
    ),
    index("idx_inventory_bin_locations_gin").using("gin", table.binLocations),
    // immutable_array_to_string() is the project-wide IMMUTABLE wrapper around
    // array_to_string(arr, sep). PostgreSQL requires IMMUTABLE functions in index
    // expressions; array_to_string is only STABLE so the wrapper (defined in
    // _untracked_0001_fts_ai_keywords.sql) is required. Queries must use the same
    // expression to get the index scan — see inventory route binPrefix filter.
    index("idx_inventory_bin_locs_prefix_trgm").using(
      "gin",
      sql`immutable_array_to_string(bin_locations, E'\n') gin_trgm_ops`,
    ),
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
  dismissed: boolean("dismissed").notNull().default(false),
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
    sectionNum: integer("section_num").notNull().default(0),
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
    uniqueIndex("warehouse_zone_aisle_section_idx").on(
      table.aisleId,
      table.sectionNum,
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
