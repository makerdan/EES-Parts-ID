-- Migration 0030: Backfill columns that were applied via `drizzle-kit push` without migration files.
--
-- admin_preferences: text_size, theme_mode, default_confidence_threshold,
--                    scan_sound, shelf_prefix, shelf_step, ai_provider
-- catalog_pdf_job:   images_matched
--
-- All statements use ADD COLUMN IF NOT EXISTS so this is safe to re-apply.

--> statement-breakpoint
ALTER TABLE "admin_preferences"
  ADD COLUMN IF NOT EXISTS "text_size"                      text    NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "theme_mode"                     text    NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS "default_confidence_threshold"   integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "scan_sound"                     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "shelf_prefix"                   text,
  ADD COLUMN IF NOT EXISTS "shelf_step"                     integer,
  ADD COLUMN IF NOT EXISTS "ai_provider"                    text;

--> statement-breakpoint
ALTER TABLE "catalog_pdf_job"
  ADD COLUMN IF NOT EXISTS "images_matched" integer NOT NULL DEFAULT 0;
