-- Prevent concurrent duplicate writes: no two zones may share the same
-- aisle_id + section_parity combination.
--
-- Step 1: Remove any pre-existing duplicate rows, keeping the highest-id
-- (most-recently created) row per (aisle_id, section_parity) group.
-- This is a no-op when no duplicates exist, so it is safe to run on a
-- clean database.
DELETE FROM warehouse_zone
WHERE id NOT IN (
  SELECT MAX(id)
  FROM warehouse_zone
  GROUP BY aisle_id, section_parity
);
--> statement-breakpoint
-- Step 2: Add the unique index now that duplicates are gone.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_zone_aisle_parity_idx
  ON warehouse_zone (aisle_id, section_parity);
