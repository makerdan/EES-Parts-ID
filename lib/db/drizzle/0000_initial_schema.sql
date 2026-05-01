-- Parts ID — initial schema + search indexes
-- Generated from Drizzle schema + manually added pg_trgm / FTS indexes

-- Extensions required for trigram search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Core inventory table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inventory" (
  "id"           serial PRIMARY KEY,
  "vendor"       text NOT NULL,
  "catalog"      text NOT NULL,
  "description"  text NOT NULL DEFAULT '',
  "bin_location" text NOT NULL DEFAULT '',
  "ai_keywords"  text[] NOT NULL DEFAULT ARRAY[]::text[],
  "enriched_at"  timestamp,
  "created_at"   timestamp DEFAULT now() NOT NULL,
  "updated_at"   timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_vendor_catalog_idx"
  ON "inventory" ("vendor", "catalog");

-- Trigram indexes for fast similarity search
CREATE INDEX IF NOT EXISTS "inventory_catalog_trgm_idx"
  ON "inventory" USING GIN ("catalog" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "inventory_description_trgm_idx"
  ON "inventory" USING GIN ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "inventory_vendor_trgm_idx"
  ON "inventory" USING GIN ("vendor" gin_trgm_ops);

-- Full-text search index on vendor + catalog + description
-- IMMUTABLE wrapper so array_to_string can be used in a functional GIN index
CREATE OR REPLACE FUNCTION immutable_array_to_string(arr text[], sep text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT array_to_string(arr, sep); $$;

CREATE INDEX IF NOT EXISTS "inventory_fts_idx"
  ON "inventory" USING GIN (
    to_tsvector('english',
      coalesce("vendor", '') || ' ' ||
      coalesce("catalog", '') || ' ' ||
      coalesce("description", '') || ' ' ||
      immutable_array_to_string("ai_keywords", ' ')
    )
  );

-- ── Dictionary tables ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "abbreviation_map" (
  "id"           serial PRIMARY KEY,
  "abbreviation" text NOT NULL UNIQUE,
  "expansions"   text[] NOT NULL DEFAULT ARRAY[]::text[],
  "category"     text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "vendor_map" (
  "id"    serial PRIMARY KEY,
  "code"  text NOT NULL UNIQUE,
  "names" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "notes" text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "synonym_map" (
  "id"       serial PRIMARY KEY,
  "term"     text NOT NULL UNIQUE,
  "synonyms" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "category" text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "misspelling_map" (
  "id"          serial PRIMARY KEY,
  "misspelling" text NOT NULL UNIQUE,
  "correction"  text NOT NULL
);

CREATE TABLE IF NOT EXISTS "electrical_slang_map" (
  "id"             serial PRIMARY KEY,
  "slang_term"     text NOT NULL UNIQUE,
  "standard_terms" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "category"       text NOT NULL DEFAULT '',
  "notes"          text NOT NULL DEFAULT ''
);

-- ── Dictionary table indexes (trigram + FTS for fast expansion lookups) ───────
CREATE INDEX IF NOT EXISTS synonym_map_term_trgm_idx
  ON "synonym_map" USING GIN ("term" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS synonym_map_term_fts_idx
  ON "synonym_map" USING GIN (to_tsvector('english', "term"));

CREATE INDEX IF NOT EXISTS abbreviation_map_abbrev_trgm_idx
  ON "abbreviation_map" USING GIN ("abbreviation" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS abbreviation_map_abbrev_fts_idx
  ON "abbreviation_map" USING GIN (to_tsvector('english', "abbreviation"));

CREATE INDEX IF NOT EXISTS misspelling_map_word_trgm_idx
  ON "misspelling_map" USING GIN ("misspelling" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS slang_map_term_trgm_idx
  ON "electrical_slang_map" USING GIN ("slang_term" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS slang_map_term_fts_idx
  ON "electrical_slang_map" USING GIN (to_tsvector('english', "slang_term"));

-- ── Conversation / message tables (reference chat history) ─────────────────
CREATE TABLE IF NOT EXISTS "conversations" (
  "id"         serial PRIMARY KEY,
  "title"      text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "messages" (
  "id"              serial PRIMARY KEY,
  "conversation_id" integer NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "role"            text NOT NULL,
  "content"         text NOT NULL,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL
);
