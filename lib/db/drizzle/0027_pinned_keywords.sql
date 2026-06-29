-- Add pinned_keywords column to inventory table.
--
-- Pinned keywords are explicitly set by an admin via PATCH /inventory/:id/keywords.
-- Enrichment jobs (bulk-enrich, per-item PATCH /:id/enrich, SSE enrich) MUST
-- merge this column back into ai_keywords after generating new AI keywords so
-- that manually-curated terms (e.g. "Cutler-Hammer" on BAB breakers) are never
-- silently dropped by a future re-enrichment run.
ALTER TABLE "inventory"
  ADD COLUMN IF NOT EXISTS "pinned_keywords" text[] NOT NULL DEFAULT ARRAY[]::text[];

-- Backfill: seed pinned_keywords from the existing ai_keywords array for every
-- BAB-series row that already has 'Cutler-Hammer' in ai_keywords.
--
-- These rows were populated by the add-cutler-hammer-keywords.ts migration
-- (Task #1923) and represent manually-curated brand keywords that must survive
-- future re-enrichment.  Copying the full ai_keywords array here ensures ALL
-- curated terms on these parts (not just "Cutler-Hammer") are preserved.
--
-- Safe to run more than once: the WHERE clause only updates rows where
-- pinned_keywords is still empty and the Cutler-Hammer keyword is present.
UPDATE inventory
  SET pinned_keywords = ai_keywords
  WHERE 'Cutler-Hammer' = ANY(ai_keywords)
    AND pinned_keywords = ARRAY[]::text[];
