-- Migration 0006: Add reference_answer_cache table
--
-- Caches free-form AI answers keyed on a normalized question hash so that
-- repeated questions skip the OpenAI call and return the stored answer.
-- cachedAt drives a server-side TTL check (3 days) and is reset on every
-- cache hit-refresh or write-back. The table is truncated whenever inventory
-- is mutated so answers containing stale inventory context don't persist.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reference_answer_cache" (
  "question_hash" text PRIMARY KEY,
  "question"      text NOT NULL,
  "answer"        text NOT NULL,
  "cached_at"     timestamptz NOT NULL DEFAULT now()
);
