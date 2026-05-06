-- Task: Add search telemetry tables (Stage 1 of Search Overhaul — Task #185).
--
-- search_event: one row per POST /inventory/search call. Records the raw and
-- normalized query, which pipeline layers fired, result count, and latency so
-- later ranking changes can be evaluated against real warehouse queries.
--
-- search_event_click: one row per result-card tap (card expansion = result tap
-- in this UX — cards expand in-place, there is no separate detail navigation).
-- Correlates a result with the originating search event for CTR analysis.
--
-- Notes:
--   - No user_id / session_id — workers are anonymous.
--   - result_id is nullable: FK uses ON DELETE SET NULL so click rows survive
--     part deletions and remain analyzable in aggregate.
--   - filters_json captures the full chip filter state at query time as JSONB.
--   - layers_hit is a text[] recording which search layers contributed results:
--     'fts', 'trigram', 'exact_catalog', 'fuse_fallback', 'vendor_boost'.

CREATE TABLE IF NOT EXISTS "search_event" (
  "id"               bigserial PRIMARY KEY,
  "ts"               timestamptz NOT NULL DEFAULT now(),
  "query_raw"        text NOT NULL,
  "query_normalized" text NOT NULL,
  "query_source"     text NOT NULL,
  "filters_json"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "results_count"    integer NOT NULL,
  "top_result_id"    integer NULL,
  "latency_ms"       integer NOT NULL,
  "layers_hit"       text[] NOT NULL DEFAULT '{}'::text[]
);

CREATE INDEX IF NOT EXISTS "idx_search_event_ts"    ON "search_event" ("ts" DESC);
CREATE INDEX IF NOT EXISTS "idx_search_event_query" ON "search_event" ("query_normalized");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "search_event_click" (
  "id"              bigserial PRIMARY KEY,
  "search_event_id" bigint NOT NULL REFERENCES "search_event"("id") ON DELETE CASCADE,
  "ts"              timestamptz NOT NULL DEFAULT now(),
  "result_id"       integer NULL REFERENCES "inventory"("id") ON DELETE SET NULL,
  "result_rank"     integer NOT NULL,
  "action"          text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_search_event_click_event"  ON "search_event_click" ("search_event_id");
CREATE INDEX IF NOT EXISTS "idx_search_event_click_result" ON "search_event_click" ("result_id", "ts" DESC);
