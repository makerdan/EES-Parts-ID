-- Add a trigram GIN index on the lowercased full-text concatenation.
--
-- This index is used exclusively by the uncategorized-browse exclusion query:
--
--   id NOT IN (
--     SELECT id FROM inventory
--     WHERE lower(vendor || ' ' || catalog || ' ' || description || ' ' ||
--                 coalesce(expanded_description, '') || ' ' ||
--                 immutable_array_to_string(ai_keywords, ' '))
--           ~ 'kw1|kw2|kw3|...'
--   )
--
-- pg_trgm accelerates regex (~) patterns with a GIN index, so the inner
-- positive match becomes a Bitmap Index Scan, and the outer NOT IN becomes
-- a Hash Anti Join — no full sequential scan needed.
--
-- The expression must stay in sync with the WHERE clause in the uncategorized
-- browse path (artifacts/api-server/src/routes/inventory.ts) and the index
-- definition in lib/db/src/schema/inventory.ts.
--
-- Prerequisite: immutable_array_to_string() must exist (created in
-- _untracked_0001_fts_ai_keywords.sql or migration 0000_initial_schema.sql).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS inventory_fulltext_trgm_idx
ON inventory USING GIN (
  lower(
    vendor || ' ' || catalog || ' ' || description || ' ' ||
    coalesce(expanded_description, '') || ' ' ||
    immutable_array_to_string(ai_keywords, ' ')
  )
  gin_trgm_ops
);
