-- Migration 0009: Add expression index on (dimensions->>'length')::numeric
--
-- Without this index, the size-range filter (minLength/maxLength) performs a
-- full table scan because PostgreSQL must evaluate the jsonb extraction and
-- numeric cast for every row.  A generated expression index lets the planner
-- use a B-tree seek instead, keeping filter queries fast as inventory grows.

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_dimensions_length_idx"
  ON "inventory" (((dimensions->>'length')::numeric));
