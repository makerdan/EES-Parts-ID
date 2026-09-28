CREATE TABLE IF NOT EXISTS "description_expansion_job" (
  "id" serial PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "cursor" integer DEFAULT 0 NOT NULL,
  "model" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "total" integer,
  "processed" integer DEFAULT 0 NOT NULL,
  "saved" integer DEFAULT 0 NOT NULL,
  "discarded" integer DEFAULT 0 NOT NULL,
  "errors" integer DEFAULT 0 NOT NULL,
  "error_message" text
);

CREATE INDEX IF NOT EXISTS "description_expansion_job_status_id_idx"
  ON "description_expansion_job" ("status", "id");