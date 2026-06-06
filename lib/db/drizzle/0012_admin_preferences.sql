-- Migration 0012: Add admin_preferences table
--
-- Stores server-side admin profile preferences so settings like
-- dimensionUnit (mm/cm/in) follow the admin across devices.
-- Single-row design (id=1) since the app uses a shared admin password,
-- not per-user identities.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_preferences" (
  "id"             integer PRIMARY KEY DEFAULT 1,
  "dimension_unit" text    NOT NULL    DEFAULT 'mm',
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
INSERT INTO "admin_preferences" ("id", "dimension_unit", "updated_at")
VALUES (1, 'mm', now())
ON CONFLICT ("id") DO NOTHING;
