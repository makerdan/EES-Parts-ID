/**
 * `inventory_barcode` — maps any scanned string (UPC, EAN, QR payload,
 * Code 128, etc.) to an inventory row. Populated three ways:
 *
 *   - `catalog-auto`: server matched the scan directly to inventory.catalog
 *     (case-insensitive) and recorded the binding so future scans skip
 *     the catalog scan.
 *   - `upc-linked`:   warehouse worker scanned an unknown barcode and
 *     picked the matching part via the scan-to-link flow.
 *   - `manual`:       admin entered the binding by hand (CSV import,
 *     etc.) — reserved for future use.
 *
 * The barcode itself is the primary key — every scan is one normalized
 * string and every string maps to at most one active part. Re-linking
 * the same barcode to a different part overwrites the row (the
 * /barcode/link endpoint enforces a `force` flag for that case).
 */
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod/v4';
import { inventoryTable } from './inventory';

export const BARCODE_SOURCES = ['catalog-auto', 'upc-linked', 'manual'] as const;
export type BarcodeSource = (typeof BARCODE_SOURCES)[number];

export const inventoryBarcodeTable = pgTable(
  'inventory_barcode',
  {
    barcode: text('barcode').primaryKey(),
    inventoryId: integer('inventory_id')
      .notNull()
      .references(() => inventoryTable.id, { onDelete: 'cascade' }),
    source: text('source').notNull().default('upc-linked'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    createdBy: text('created_by'),
  },
  (table) => [index('inventory_barcode_inventory_idx').on(table.inventoryId)]
);

export const insertInventoryBarcodeSchema = createInsertSchema(inventoryBarcodeTable).omit({
  createdAt: true,
});
export type InsertInventoryBarcode = z.infer<typeof insertInventoryBarcodeSchema>;
export type InventoryBarcode = typeof inventoryBarcodeTable.$inferSelect;
