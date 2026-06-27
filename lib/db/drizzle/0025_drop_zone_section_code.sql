-- Drop the deprecated section_code column and its unique index from warehouse_zone.
-- The column was fully wiped (all rows set to NULL) by the migrateWarehouseZoneSectionCode
-- startup function before this migration was created; it is now safe to remove entirely.
DROP INDEX IF EXISTS "warehouse_zone_section_code_idx";
ALTER TABLE "warehouse_zone" DROP COLUMN IF EXISTS "section_code";
