-- Migration 0007: Add ai_request_log and screen_view_log tables
--
-- ai_request_log: fire-and-forget per-request log for AI feature calls
--   (feature enum: identify = Photo ID, reference = Reference Assistant).
-- screen_view_log: privacy-safe screen view tracking using a SHA-256 hash
--   of the requester's IP address (no PII stored).

--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "ai_feature" AS ENUM ('identify', 'reference');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_request_log" (
  "id"         serial PRIMARY KEY,
  "feature"    "ai_feature" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "screen_view_log" (
  "id"           serial PRIMARY KEY,
  "screen_name"  text NOT NULL,
  "visitor_hash" text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
