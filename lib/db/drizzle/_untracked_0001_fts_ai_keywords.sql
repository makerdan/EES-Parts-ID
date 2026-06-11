-- HISTORICAL BOOTSTRAP — not the source of truth for schema.
-- This file was applied manually to databases that pre-dated the Drizzle migration
-- history. It is kept for reference only. The canonical FTS index definition is
-- now tracked in lib/db/src/schema/inventory.ts (inventory_fts_idx). The
-- immutable_array_to_string() function defined below is still required by the
-- index and must be present in the database before drizzle-kit push runs.
-- DO NOT re-apply this file to bring the index in sync — use drizzle-kit push.
--
-- Migration: FTS ai_keywords inclusion + full-text AND trigram indexes on dict tables
-- Apply once to existing databases: psql $DATABASE_URL -f 0001_fts_ai_keywords.sql

CREATE OR REPLACE FUNCTION immutable_array_to_string(arr text[], sep text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT array_to_string(arr, sep); $$;

-- Drop old FTS index (excluded ai_keywords) and rebuild with it included
DROP INDEX IF EXISTS inventory_fts_idx;
CREATE INDEX inventory_fts_idx
  ON inventory USING GIN (
    to_tsvector('english',
      coalesce(vendor, '') || ' ' ||
      coalesce(catalog, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      immutable_array_to_string(ai_keywords, ' ')
    )
  );

-- ── Synonym map indexes (trigram + FTS) ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS synonym_map_term_trgm_idx
  ON synonym_map USING GIN (term gin_trgm_ops);

CREATE INDEX IF NOT EXISTS synonym_map_term_fts_idx
  ON synonym_map USING GIN (to_tsvector('english', term));

-- ── Abbreviation map indexes (trigram + FTS) ─────────────────────────────────
CREATE INDEX IF NOT EXISTS abbreviation_map_abbrev_trgm_idx
  ON abbreviation_map USING GIN (abbreviation gin_trgm_ops);

CREATE INDEX IF NOT EXISTS abbreviation_map_abbrev_fts_idx
  ON abbreviation_map USING GIN (to_tsvector('english', abbreviation));

-- ── Misspelling map indexes (trigram — FTS less useful for raw misspellings) ──
CREATE INDEX IF NOT EXISTS misspelling_map_word_trgm_idx
  ON misspelling_map USING GIN (misspelling gin_trgm_ops);

-- ── Slang map indexes (trigram + FTS) ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS slang_map_term_trgm_idx
  ON electrical_slang_map USING GIN (slang_term gin_trgm_ops);

CREATE INDEX IF NOT EXISTS slang_map_term_fts_idx
  ON electrical_slang_map USING GIN (to_tsvector('english', slang_term));

-- ── Vendor map indexes (trigram on code + array names) ───────────────────────
CREATE INDEX IF NOT EXISTS vendor_map_code_trgm_idx
  ON vendor_map USING GIN (code gin_trgm_ops);

CREATE INDEX IF NOT EXISTS vendor_map_names_fts_idx
  ON vendor_map USING GIN (immutable_array_to_string(names, ' ') gin_trgm_ops);
