-- Migration 0031: Add rate_limit_buckets table for PostgreSQL-backed sliding-window rate limiting.
--
-- key        — limiter namespace + user key (PK), e.g. "identify:user_abc"
-- timestamps — bigint[] of hit epoch-ms values within the current window
-- updated_at — used to prune fully-expired rows opportunistically

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
  "key"          text        PRIMARY KEY,
  "timestamps"   bigint[]    NOT NULL DEFAULT '{}',
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_buckets_updated_at_idx"
  ON "rate_limit_buckets" ("updated_at");
