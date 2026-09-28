ALTER TABLE "inventory_snapshot_audit"
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;

-- Rows written before leases existed cannot be safely resumed by a new
-- instance, so make them immediately recoverable by the first new claimant.
UPDATE "inventory_snapshot_audit"
SET "lease_expires_at" = now() - interval '1 second'
WHERE "action" = 'manual-backup'
  AND "outcome" = 'running'
  AND "lease_expires_at" IS NULL;