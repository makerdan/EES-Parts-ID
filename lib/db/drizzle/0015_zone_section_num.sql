-- Drop old parity constraint and unique index
ALTER TABLE "warehouse_zone" DROP CONSTRAINT IF EXISTS "warehouse_zone_section_parity_check";
DROP INDEX IF EXISTS "warehouse_zone_aisle_parity_idx";

-- Add section_num, migrate from parity, make NOT NULL
ALTER TABLE "warehouse_zone" ADD COLUMN "section_num" integer;
UPDATE "warehouse_zone"
  SET "section_num" = CASE
    WHEN section_parity = 'odd'  THEN 1
    WHEN section_parity = 'even' THEN 2
    ELSE 0
  END;
ALTER TABLE "warehouse_zone" ALTER COLUMN "section_num" SET NOT NULL;
ALTER TABLE "warehouse_zone" DROP COLUMN "section_parity";

-- New unique constraint: one zone per aisle + section combination
CREATE UNIQUE INDEX "warehouse_zone_aisle_section_idx"
  ON "warehouse_zone" ("aisle_id", "section_num");
