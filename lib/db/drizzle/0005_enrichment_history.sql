-- Task #118: catalog-PDF enrichment audit trail.
--
--   inventory_enrichment_run     — one row per /admin/catalog-pdf/apply call.
--                                  Carries vendor, source filename, summary
--                                  counts, and a `reverted_at` marker so the
--                                  admin UI can grey out reverted runs and
--                                  the revert endpoint can reject double-
--                                  revert attempts.
--
--   inventory_enrichment_history — one row per inventory mutation in a run.
--                                  Stores BOTH the before- and after- values
--                                  for description and aiKeywords so revert
--                                  is a straight `UPDATE inventory SET … =
--                                  before_*`, processed newest→oldest so
--                                  rows touched multiple times in one run
--                                  end at the true pre-run state.
--
-- Both tables are write-only audit data; cascade deletes keep them in sync
-- with the rows they reference (e.g. dropping an inventory row also drops
-- its history; deleting a run drops its history).

CREATE TABLE IF NOT EXISTS "inventory_enrichment_run" (
  "id"              serial PRIMARY KEY NOT NULL,
  "vendor"          text NOT NULL,
  "source_filename" text,
  "started_at"      timestamp DEFAULT now() NOT NULL,
  "finished_at"     timestamp,
  "updated_count"   integer DEFAULT 0 NOT NULL,
  "skipped_count"   integer DEFAULT 0 NOT NULL,
  "error_count"     integer DEFAULT 0 NOT NULL,
  "reverted_at"     timestamp
);

CREATE INDEX IF NOT EXISTS "enrichment_run_started_at_idx"
  ON "inventory_enrichment_run" ("started_at");

CREATE TABLE IF NOT EXISTS "inventory_enrichment_history" (
  "id"                 serial PRIMARY KEY NOT NULL,
  "run_id"             integer NOT NULL,
  "inventory_id"       integer NOT NULL,
  "catalog_number"     text NOT NULL,
  "before_description" text NOT NULL,
  "after_description"  text NOT NULL,
  "before_keywords"    text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "after_keywords"     text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "created_at"         timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_enrichment_history_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "inventory_enrichment_run"("id") ON DELETE CASCADE,
  CONSTRAINT "inventory_enrichment_history_inventory_id_fkey"
    FOREIGN KEY ("inventory_id") REFERENCES "inventory"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "enrichment_history_run_id_idx"
  ON "inventory_enrichment_history" ("run_id");

CREATE INDEX IF NOT EXISTS "enrichment_history_inventory_id_idx"
  ON "inventory_enrichment_history" ("inventory_id");
