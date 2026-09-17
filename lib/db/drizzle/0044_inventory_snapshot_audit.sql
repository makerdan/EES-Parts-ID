CREATE TABLE IF NOT EXISTS "inventory_snapshot_audit" (
  "id" serial PRIMARY KEY NOT NULL,
  "admin_clerk_user_id" text NOT NULL,
  "snapshot_id" text NOT NULL,
  "action" text NOT NULL,
  "row_count" integer,
  "outcome" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "inventory_snapshot_audit_snapshot_idx"
  ON "inventory_snapshot_audit" ("snapshot_id", "created_at");