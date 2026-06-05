-- Migration 0010: Add expression index on (dimensions->>'diameter')::numeric
--
-- Without this index, diameter-based filtering performs a full table scan
-- because PostgreSQL must evaluate the jsonb extraction and numeric cast for
-- every row.  A generated expression index lets the planner use a B-tree seek
-- instead, keeping filter queries fast as inventory grows — mirroring the
-- existing length index added in migration 0009.

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_dimensions_diameter_idx"
  ON "inventory" (((dimensions->>'diameter')::numeric));
