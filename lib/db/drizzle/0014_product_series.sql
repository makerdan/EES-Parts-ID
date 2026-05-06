-- Migration 0014: product series
-- Introduces a formal product_series table so inventory items can be
-- explicitly linked into a series rather than relying on catalog-prefix heuristics.

CREATE TABLE IF NOT EXISTS product_series (
  id         serial PRIMARY KEY,
  name       text    NOT NULL,
  vendor     text    NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: one series per (vendor, name) pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_series_vendor_name
  ON product_series (vendor, name);

-- Add nullable series_id FK to inventory
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS series_id integer REFERENCES product_series(id) ON DELETE SET NULL;

-- Index for fast series membership lookups
CREATE INDEX IF NOT EXISTS idx_inventory_series_id
  ON inventory (series_id) WHERE series_id IS NOT NULL;
