-- Migration 0008: Add dimensions jsonb column to inventory table
--
-- Stores physical part dimensions (length, width, height, diameter in mm)
-- as a jsonb object.  All fields are optional / nullable.
-- Added to support LiDAR/camera-based auto-measurement and size-range filtering.

--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "dimensions" jsonb;
