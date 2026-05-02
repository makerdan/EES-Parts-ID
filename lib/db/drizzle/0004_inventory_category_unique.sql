-- Task #100 follow-up: enforce "exactly one category path per inventory item"
-- at the schema level. The original PK was (inventory_id, category_node_id),
-- which permitted multiple rows per inventory_id. The classifier already
-- writes one row per item via delete-then-insert, but we want the database
-- itself to reject multi-assignment drift (manual SQL edits, partial
-- failures, future code paths).
--
-- Strategy:
--   1. Defensively de-duplicate any existing rows, keeping the most recently
--      classified row per inventory_id.
--   2. Drop the old composite PK and replace with a single-column PK on
--      inventory_id. This makes "one row per item" a hard invariant.

-- 1. de-dupe (safe even on empty tables)
DELETE FROM inventory_category a USING inventory_category b
WHERE a.inventory_id = b.inventory_id
  AND a.classified_at < b.classified_at;

-- 2. swap the primary key
ALTER TABLE inventory_category DROP CONSTRAINT IF EXISTS inventory_category_pkey;
ALTER TABLE inventory_category
  ADD CONSTRAINT inventory_category_pkey PRIMARY KEY (inventory_id);
