-- Migration 0005: Add dismissed column to catalog_pdf_job table
--
-- Allows admins to dismiss failed PDF jobs once they have resubmitted them,
-- so the failed jobs section in the review screen does not grow unbounded.
-- Defaults to false so all existing rows are valid without back-fill.

--> statement-breakpoint
ALTER TABLE "catalog_pdf_job" ADD COLUMN IF NOT EXISTS "dismissed" boolean DEFAULT false NOT NULL;
