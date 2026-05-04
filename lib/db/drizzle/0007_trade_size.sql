-- Task: Add user-editable trade_size column to inventory.
--
-- Trade size groups the same product type across different physical sizes
-- (e.g. 1/2", 3/4", 1") so workers can find related sizes quickly.
-- Nullable — set only for parts where a size classification is meaningful.

ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "trade_size" text;
