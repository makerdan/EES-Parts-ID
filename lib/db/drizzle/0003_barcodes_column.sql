-- Migration 0003: Add barcodes column to inventory table
--
-- Adds a text array column to store one or more barcode values (UPC, EAN,
-- Code128, QR, etc.) associated with a catalog part. Defaults to an empty
-- array so existing rows are valid without back-fill.

--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "barcodes" text[] DEFAULT '{}' NOT NULL;
