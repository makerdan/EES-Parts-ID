-- Global zone-layer alignment calibration for the warehouse Map.
-- A single offset (translate + uniform scale) applied uniformly to every zone
-- overlay on top of the shared pan/zoom. Stored on the admin_preferences
-- singleton (id = 1). Defaults to identity (0, 0, 1) = no shift, no scale.
ALTER TABLE "admin_preferences" ADD COLUMN IF NOT EXISTS "zone_align_x" double precision NOT NULL DEFAULT 0;
ALTER TABLE "admin_preferences" ADD COLUMN IF NOT EXISTS "zone_align_y" double precision NOT NULL DEFAULT 0;
ALTER TABLE "admin_preferences" ADD COLUMN IF NOT EXISTS "zone_align_scale" double precision NOT NULL DEFAULT 1;
