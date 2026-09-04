ALTER TABLE "catalog_pdf_job"
  ADD COLUMN IF NOT EXISTS "owner_clerk_user_id" text;

CREATE INDEX IF NOT EXISTS "catalog_pdf_job_owner_idx"
  ON "catalog_pdf_job" ("owner_clerk_user_id", "created_at");