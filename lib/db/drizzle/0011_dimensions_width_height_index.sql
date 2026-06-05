-- Migration 0011: Add expression indexes on (dimensions->>'width')::numeric
--                 and (dimensions->>'height')::numeric
--
-- Mirrors the length (0009) and diameter (0010) indexes so that width- and
-- height-based range filters use B-tree seeks instead of full table scans.

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_dimensions_width_idx"
  ON "inventory" (((dimensions->>'width')::numeric));

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_dimensions_height_idx"
  ON "inventory" (((dimensions->>'height')::numeric));
