-- Add chunking columns to catalog_pdf_job.
-- All columns are nullable so existing rows remain valid.
ALTER TABLE "catalog_pdf_job" ADD COLUMN IF NOT EXISTS "parent_job_id" integer;
ALTER TABLE "catalog_pdf_job" ADD COLUMN IF NOT EXISTS "chunk_index" integer;
ALTER TABLE "catalog_pdf_job" ADD COLUMN IF NOT EXISTS "chunk_count" integer;
ALTER TABLE "catalog_pdf_job" ADD COLUMN IF NOT EXISTS "page_offset" integer;
