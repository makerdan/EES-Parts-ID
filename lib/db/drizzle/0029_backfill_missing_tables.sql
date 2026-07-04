-- Migration 0029: Backfill tables that were applied via `drizzle-kit push` without migration files.
--
-- Affected tables: users, contact_messages, floor_plan_meta,
--                  measure_enrich_job, quick_lookup_cache, reference_log
--
-- All statements use IF NOT EXISTS so this is safe to run against environments
-- that already have these tables.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
  "clerk_user_id" text PRIMARY KEY NOT NULL,
  "email"         text NOT NULL DEFAULT '',
  "status"        text NOT NULL DEFAULT 'pending',
  "role"          text NOT NULL DEFAULT 'user',
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_messages" (
  "id"           serial PRIMARY KEY NOT NULL,
  "sender_token" text NOT NULL,
  "subject"      text NOT NULL,
  "body"         text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "read_at"      timestamptz
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "floor_plan_meta" (
  "id"          serial PRIMARY KEY NOT NULL,
  "object_path" text NOT NULL,
  "hash"        text NOT NULL,
  "uploaded_at" timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "measure_enrich_job" (
  "id"            serial PRIMARY KEY NOT NULL,
  "status"        text NOT NULL DEFAULT 'running',
  "started_at"    timestamptz NOT NULL DEFAULT now(),
  "finished_at"   timestamptz,
  "processed"     integer NOT NULL DEFAULT 0,
  "updated"       integer NOT NULL DEFAULT 0,
  "error_message" text
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quick_lookup_cache" (
  "label"      text PRIMARY KEY NOT NULL,
  "answer"     text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reference_log" (
  "id"                 serial PRIMARY KEY NOT NULL,
  "question"           text NOT NULL,
  "answer"             text NOT NULL,
  "matched_item_count" integer NOT NULL DEFAULT 0,
  "created_at"         timestamptz NOT NULL DEFAULT now()
);
