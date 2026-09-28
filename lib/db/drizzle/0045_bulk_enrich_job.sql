CREATE TABLE IF NOT EXISTS "bulk_enrich_job" (
  "id" serial PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "force" boolean DEFAULT false NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "processed" integer DEFAULT 0 NOT NULL,
  "errors" integer DEFAULT 0 NOT NULL,
  "total" integer,
  "error_message" text,
  "model" text
);

-- Retention keeps only the newest terminal outcome for restart recovery.
-- Running and stopping rows are intentionally not eligible for cleanup.
CREATE INDEX IF NOT EXISTS "bulk_enrich_job_status_id_idx"
  ON "bulk_enrich_job" ("status", "id");