ALTER TABLE "inventory_snapshot_audit"
  ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "error_message" text;

CREATE INDEX IF NOT EXISTS "inventory_snapshot_audit_manual_backup_idx"
  ON "inventory_snapshot_audit" ("action", "created_at");