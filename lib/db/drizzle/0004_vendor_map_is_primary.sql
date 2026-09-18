-- Migration 0004: Add is_primary flag to vendor_map table
--
-- Distinguishes the 68 authoritative primary vendors from the broader
-- ~300-entry extended fallback list. Default false so existing rows
-- remain non-primary until re-seeded.

--> statement-breakpoint
ALTER TABLE "vendor_map" ADD COLUMN IF NOT EXISTS "is_primary" boolean NOT NULL DEFAULT false;
