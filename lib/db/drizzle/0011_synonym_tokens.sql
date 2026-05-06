-- pg_trgm extension already enabled by migration 0009_fts_weighted.sql

-- synonym_group: one row per canonical term with all equivalent forms.
-- Populated at enrichment time; bidirectional expansion is handled in
-- buildSearchTokens() so every inventory row that mentions any group
-- member gets all members added to its search_tokens column.
CREATE TABLE IF NOT EXISTS synonym_group (
  id            serial PRIMARY KEY,
  canonical     text NOT NULL UNIQUE,
  synonyms      text[] NOT NULL DEFAULT '{}',
  category_hint text,
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Denormalized token column on inventory: built once at enrichment time,
-- contains all base words PLUS synonym expansions so trigram search
-- operates against a single pre-expanded string instead of doing
-- five table lookups on every query.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS search_tokens text;

-- GIN trigram index for fast similarity() / % queries against the
-- expanded token column. Partial index (WHERE IS NOT NULL) avoids
-- indexing rows that haven't been backfilled yet.
CREATE INDEX IF NOT EXISTS idx_inventory_search_tokens_trgm
  ON inventory USING GIN (search_tokens gin_trgm_ops)
  WHERE search_tokens IS NOT NULL;
