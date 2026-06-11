ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "expanded_description" text;

-- Rebuild the FTS GIN index to include expanded_description so saved
-- expansions are immediately searchable without a separate index refresh.
-- NOTE: The canonical index definition is now tracked in Drizzle schema
-- (lib/db/src/schema/inventory.ts, inventory_fts_idx). This raw DDL block is
-- retained as a historical record of the migration but is NOT the source of
-- truth. Future changes to the index must be made in the schema file.
DROP INDEX IF EXISTS inventory_fts_idx;
CREATE INDEX inventory_fts_idx
  ON inventory USING GIN (
    to_tsvector('english',
      coalesce(vendor, '') || ' ' ||
      coalesce(catalog, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(expanded_description, '') || ' ' ||
      immutable_array_to_string(ai_keywords, ' ')
    )
  );
