-- Add section_code column to warehouse_zone.
-- Nullable text, globally unique (NULLs are not considered equal in PG unique indexes).
-- Used as a human-visible label (4 uppercase letters, e.g. JKQM) that overrides
-- the numeric section_num display whenever it is set.
ALTER TABLE "warehouse_zone" ADD COLUMN IF NOT EXISTS "section_code" text;
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_zone_section_code_idx" ON "warehouse_zone" ("section_code") WHERE section_code IS NOT NULL;
