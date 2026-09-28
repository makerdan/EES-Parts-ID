ALTER TABLE "description_expansion_job"
  ADD COLUMN IF NOT EXISTS "owner_id" text,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;

-- Existing active rows have no trustworthy owner signal and should be
-- recoverable immediately after the current database worker lock is released.
UPDATE "description_expansion_job"
SET "lease_expires_at" = now() - interval '1 second'
WHERE "status" IN ('running', 'stopping')
  AND "lease_expires_at" IS NULL;