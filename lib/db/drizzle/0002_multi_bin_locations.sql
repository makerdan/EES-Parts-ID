-- Migration: replace single `bin_location` text column with `bin_locations` text[]
-- so each part can be stocked in zero, one, or many bins. Existing single-bin
-- values are migrated 1:1 into a single-element array; empty strings become
-- empty arrays. The migration also bumps `updated_at` so the mobile app's
-- `MAX(updated_at)` version probe detects the schema-driven payload change and
-- forces every client to re-sync its local Fuse cache with the new shape.
--
-- This migration is idempotent and safe to run on:
--   - a fresh DB (where 0000 already creates `bin_locations` and never created
--     `bin_location`) — the backfill block is skipped and the DROP no-ops
--   - a pre-0002 DB (where `bin_location` still exists) — the column is added,
--     backfilled row-by-row, and the legacy column is dropped
--
-- Apply once to existing databases:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0002_multi_bin_locations.sql

BEGIN;

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS bin_locations text[] NOT NULL DEFAULT ARRAY[]::text[];

-- Backfill the new array column from the legacy single-bin column ONLY when
-- the legacy column is still present. On fresh installs (where 0000 created
-- the table with `bin_locations` directly and no `bin_location`) the inner
-- UPDATE would otherwise fail with `column "bin_location" does not exist`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = current_schema()
    AND    table_name   = 'inventory'
    AND    column_name  = 'bin_location'
  ) THEN
    -- Each existing single bin becomes a one-element array; blank stays empty.
    -- Bump updated_at on every row so the mobile sync-version probe
    -- (MAX(updated_at)) detects the change and triggers a full re-sync.
    UPDATE inventory
    SET    bin_locations = CASE
                             WHEN bin_location IS NULL OR bin_location = ''
                             THEN ARRAY[]::text[]
                             ELSE ARRAY[bin_location]
                           END,
           updated_at    = now()
    WHERE  bin_location IS NOT NULL;
  END IF;
END $$;

ALTER TABLE inventory DROP COLUMN IF EXISTS bin_location;

COMMIT;
