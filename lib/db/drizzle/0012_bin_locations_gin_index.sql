-- Migration 0012: Indexes for server-side bin-location prefix filtering
--
-- Two indexes are created:
--
-- 1. gin(bin_locations) — standard GIN on the text[] array.
--    Used by Postgres for array containment (@>) and overlap (&&) queries.
--    Maintained automatically on every write.
--
-- 2. gin(array_to_string(bin_locations, E'\n') gin_trgm_ops) — trigram GIN on
--    the newline-joined string of all bin locations for a row.
--    This is what enables fast server-side ILIKE prefix searches such as:
--      array_to_string(bin_locations, E'\n') ILIKE 'A-01%'
--      OR array_to_string(bin_locations, E'\n') ILIKE E'%\nA-01%'
--    pg_trgm trigram indexes work for ILIKE patterns with or without a leading
--    wildcard when there are at least 3 usable characters in the pattern.
--    Maintained automatically on every write — no manual refresh needed.

--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_bin_locations_gin
  ON inventory USING gin(bin_locations);

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_bin_locs_prefix_trgm
  ON inventory USING gin(array_to_string(bin_locations, E'\n') gin_trgm_ops);
