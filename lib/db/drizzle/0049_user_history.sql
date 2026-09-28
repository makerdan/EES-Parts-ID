CREATE TABLE IF NOT EXISTS "user_history" (
  "clerk_user_id" text PRIMARY KEY
    REFERENCES "users" ("clerk_user_id") ON DELETE CASCADE,
  "query_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "viewed_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "scan_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);