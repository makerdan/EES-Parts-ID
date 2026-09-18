-- Add extraction summary columns to catalog_pdf_job.
-- parts_found: total AI-extracted parts (before inventory matching).
-- unmatched_parts: JSON array of {catalogNumber, description} for parts the AI
--   found but that had no matching inventory row.
ALTER TABLE "catalog_pdf_job" ADD COLUMN IF NOT EXISTS "parts_found" integer NOT NULL DEFAULT 0;
ALTER TABLE "catalog_pdf_job" ADD COLUMN IF NOT EXISTS "unmatched_parts" jsonb;
