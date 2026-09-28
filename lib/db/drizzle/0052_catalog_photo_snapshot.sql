ALTER TABLE inventory ADD COLUMN IF NOT EXISTS "previous_image_url" text;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS "previous_image_url_2" text;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS "previous_image_source" text;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS "previous_image_confidence" real;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS "previous_catalog_pdf_job_id" integer;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS "previous_photo_snapshot" boolean NOT NULL DEFAULT false;