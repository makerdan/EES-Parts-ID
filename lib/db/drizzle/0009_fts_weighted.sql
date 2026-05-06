-- Task #186: FTS Weight Classes (Stage 2 of Search Overhaul).
--
-- Replaces the flat-weighted inline to_tsvector (built at query time) with a
-- STORED generated column that assigns descending weight classes to each field:
--   A = catalog  (simple dict — preserves catalog numbers like "BR120" exactly)
--   B = vendor   (simple dict — avoids stemming brand/code tokens)
--   C = description (english dict — stem "breakers" → "break" for recall)
--   D = ai_keywords (english dict — stemmed for broad recall)
--
-- ts_rank_cd weight array {D, C, B, A} = {0.1, 0.3, 0.6, 1.0} means catalog
-- hits score 10× higher than ai_keyword hits, making catalog number matches
-- dominate the ranking.
--
-- immutable_array_to_string() was created in 0001_fts_ai_keywords.sql.

-- Drop the old flat-weighted expression index (replaced by the generated column)
DROP INDEX IF EXISTS inventory_fts_idx;

--> statement-breakpoint

-- Add the STORED generated tsvector column with per-field weight classes
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple',  coalesce(catalog,  '')), 'A') ||
  setweight(to_tsvector('simple',  coalesce(vendor,   '')), 'B') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(immutable_array_to_string(ai_keywords, ' '), '')), 'D')
) STORED;

--> statement-breakpoint

-- GIN index on the generated column — used by EXPLAIN ANALYZE on typical queries
CREATE INDEX IF NOT EXISTS idx_inventory_search_tsv ON inventory USING GIN (search_tsv);
