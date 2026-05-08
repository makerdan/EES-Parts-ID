-- Migration 0015: versioned dictionary + tokens_dict_version
--
-- Adds a single-row counter table that tracks when any dictionary table
-- (synonym_group, abbreviation_map, electrical_slang_map, misspelling_map)
-- is mutated. PostgreSQL triggers increment the counter automatically.
--
-- The companion column tokens_dict_version on inventory records which
-- dict_version each row's search_tokens was built against. The
-- POST /inventory/rebuild-tokens endpoint rebuilds only rows where
-- tokens_dict_version < the current dict_version, avoiding a full table scan.

CREATE TABLE IF NOT EXISTS dictionary_version (
  id          integer     PRIMARY KEY DEFAULT 1,
  version     integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Enforce single-row semantics at the DB level
  CONSTRAINT dictionary_version_single_row CHECK (id = 1)
);

-- Seed the single row (idempotent).
-- Start at version=1 so all existing inventory rows (tokens_dict_version=0)
-- are immediately stale and eligible for a first rebuild-tokens run.
INSERT INTO dictionary_version (id, version) VALUES (1, 1) ON CONFLICT DO NOTHING;

-- Trigger function: increment the counter and refresh the timestamp.
-- Written as an AFTER ... FOR EACH STATEMENT trigger so bulk inserts
-- (e.g. seeding 100 synonyms at once) produce exactly one version bump.
CREATE OR REPLACE FUNCTION increment_dict_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO dictionary_version (id, version, updated_at) VALUES (1, 1, now())
  ON CONFLICT (id) DO UPDATE
    SET version     = dictionary_version.version + 1,
        updated_at  = now();
  RETURN NULL;
END;
$$;

-- Trigger on synonym_group
DROP TRIGGER IF EXISTS trg_dict_ver_synonym_group ON synonym_group;
CREATE TRIGGER trg_dict_ver_synonym_group
  AFTER INSERT OR UPDATE OR DELETE ON synonym_group
  FOR EACH STATEMENT EXECUTE FUNCTION increment_dict_version();

-- Trigger on abbreviation_map
DROP TRIGGER IF EXISTS trg_dict_ver_abbreviation_map ON abbreviation_map;
CREATE TRIGGER trg_dict_ver_abbreviation_map
  AFTER INSERT OR UPDATE OR DELETE ON abbreviation_map
  FOR EACH STATEMENT EXECUTE FUNCTION increment_dict_version();

-- Trigger on electrical_slang_map
DROP TRIGGER IF EXISTS trg_dict_ver_electrical_slang_map ON electrical_slang_map;
CREATE TRIGGER trg_dict_ver_electrical_slang_map
  AFTER INSERT OR UPDATE OR DELETE ON electrical_slang_map
  FOR EACH STATEMENT EXECUTE FUNCTION increment_dict_version();

-- Trigger on misspelling_map
DROP TRIGGER IF EXISTS trg_dict_ver_misspelling_map ON misspelling_map;
CREATE TRIGGER trg_dict_ver_misspelling_map
  AFTER INSERT OR UPDATE OR DELETE ON misspelling_map
  FOR EACH STATEMENT EXECUTE FUNCTION increment_dict_version();

-- Add tokens_dict_version to inventory.
-- DEFAULT 0 backfills existing rows in one pass; NOT NULL is safe here because
-- the default is specified in the same statement (PostgreSQL evaluates DEFAULT
-- before checking NOT NULL for existing rows during ALTER TABLE).
-- Existing rows backfill with tokens_dict_version=0. Since dictionary_version
-- seeds at version=1, all existing rows are immediately considered stale and
-- will be processed on the first rebuild-tokens run.
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS tokens_dict_version integer NOT NULL DEFAULT 0;
