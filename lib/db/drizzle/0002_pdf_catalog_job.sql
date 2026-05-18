-- Migration 0002: PDF catalog import columns + job tracking table
--
-- Adds fields to "inventory" to store manufacturer catalog image/description
-- data extracted from PDF catalogs. Adds a "catalog_pdf_job" table to track
-- background processing jobs.
--
-- All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS for safe re-apply.

--> statement-breakpoint
ALTER TABLE "inventory"
  ADD COLUMN IF NOT EXISTS "image_url" text,
  ADD COLUMN IF NOT EXISTS "image_source" text,
  ADD COLUMN IF NOT EXISTS "image_confidence" numeric(4,3),
  ADD COLUMN IF NOT EXISTS "previous_description" text,
  ADD COLUMN IF NOT EXISTS "catalog_pdf_job_id" integer;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_pdf_job" (
  "id" serial PRIMARY KEY NOT NULL,
  "vendor" text NOT NULL,
  "filename" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "total_pages" integer,
  "processed_pages" integer DEFAULT 0 NOT NULL,
  "matched_parts" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
