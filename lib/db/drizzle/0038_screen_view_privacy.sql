-- Screen-view privacy hardening:
-- keep retention scans and bounded per-screen reports index-backed.
-- The nullable visitor_hash allows unique-visitor reporting to be disabled
-- safely when keyed server material is unavailable.
ALTER TABLE "screen_view_log" ALTER COLUMN "visitor_hash" DROP NOT NULL;
--> statement-breakpoint
-- Legacy rows were derived with an unkeyed stable digest. Clear them rather
-- than carrying that grouping forward into the privacy-safe contract.
UPDATE "screen_view_log" SET "visitor_hash" = NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screen_view_log_created_at_idx"
  ON "screen_view_log" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screen_view_log_screen_name_created_at_idx"
  ON "screen_view_log" ("screen_name", "created_at");