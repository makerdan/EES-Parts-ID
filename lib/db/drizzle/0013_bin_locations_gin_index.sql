-- Migration 0012: Indexes for server-side bin-location prefix filtering
--
-- IMPORTANT: array_to_string() is STABLE (not IMMUTABLE) in PostgreSQL, so it
-- cannot be used directly in an index expression. This migration reuses the
-- project-wide immutable_array_to_string(text[], text) wrapper already defined
-- in _untracked_0001_fts_ai_keywords.sql. That file must be applied first.
-- Both the index definition and the binPrefix query in GET /inventory use the
-- wrapper so the trigram index is actually applied by the planner.
--
-- Two indexes are created:
--
-- 1. gin(bin_locations) — standard GIN on the text[] array.
--    Used by Postgres for array containment (@>) and overlap (&&) queries.
--    Maintained automatically on every write.
--
-- 2. gin(immutable_array_to_string(bin_locations, E'\n') gin_trgm_ops) —
--    trigram GIN on the newline-joined string of all bin locations for a row.
--    This is what enables fast server-side ILIKE prefix searches such as:
--      immutable_array_to_string(bin_locations, E'\n') ILIKE 'A-01%'
--      OR immutable_array_to_string(bin_locations, E'\n') ILIKE E'%\nA-01%'
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
  ON inventory USING gin(immutable_array_to_string(bin_locations, E'\n') gin_trgm_ops);
