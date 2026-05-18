-- Migration 0001: inventory column rename + warehouse_zone table
--
-- 0000_initial_schema.sql created inventory with "bin_location text" (singular).
-- Current schema uses "bin_locations text[]" (plural array). This migration:
--   1. Renames/retyps the column on environments still using the old schema.
--   2. Adds the warehouse_zone table with the section_parity check constraint.
--
-- All CREATE TABLE statements use IF NOT EXISTS so this is safe to re-apply.

--> statement-breakpoint
DO $$ BEGIN
  -- Only run the rename when the old column still exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'inventory'
      AND column_name  = 'bin_location'
  ) THEN
    ALTER TABLE "inventory"
      ADD COLUMN IF NOT EXISTS "bin_locations" text[] NOT NULL DEFAULT ARRAY[]::text[];
    UPDATE "inventory"
      SET "bin_locations" = CASE
        WHEN "bin_location" IS NULL OR "bin_location" = ''
        THEN ARRAY[]::text[]
        ELSE ARRAY["bin_location"]
      END;
    ALTER TABLE "inventory" DROP COLUMN "bin_location";
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "warehouse_zone" (
  "id"             serial PRIMARY KEY NOT NULL,
  "aisle_id"       text NOT NULL,
  "label"          text NOT NULL,
  "section_parity" text DEFAULT 'all' NOT NULL,
  "is_inventory"   boolean DEFAULT true NOT NULL,
  "svg_x"          real NOT NULL,
  "svg_y"          real NOT NULL,
  "svg_width"      real NOT NULL,
  "svg_height"     real NOT NULL,
  "sort_order"     integer DEFAULT 0 NOT NULL,
  "created_at"     timestamp DEFAULT now() NOT NULL,
  "updated_at"     timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "warehouse_zone_section_parity_check"
    CHECK ("warehouse_zone"."section_parity" IN ('odd', 'even', 'all'))
);
