-- 0010_materialized_attrs.sql
-- Stage 3 of Search Overhaul: Materialized parse columns for fast structured filtering
-- and elimination of the Related-Sizes full-table scan.
--
-- New columns on the inventory table:
--   catalog_parse    jsonb       — parseCatalog() output {series, poles, amps, variant, raw, parser_version}
--   amperage         integer     — extracted amperage rating (amps field promoted for indexing)
--   pole_count       smallint    — extracted pole count (1-4)
--   voltage          integer     — extracted voltage rating
--   trade_size_in    numeric(6,3)— trade size in decimal inches (mirrors trade_size text chip label)
--   mount_type       text        — bolt-on | plug-in | din-rail | surface | flush
--   attrs_parsed_at  timestamptz — when catalog_parse was last computed (NULL = needs backfill)
--   prompt_version   smallint    — AI prompt version used when enriched_at was set

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS catalog_parse   jsonb,
  ADD COLUMN IF NOT EXISTS amperage        integer,
  ADD COLUMN IF NOT EXISTS pole_count      smallint,
  ADD COLUMN IF NOT EXISTS voltage         integer,
  ADD COLUMN IF NOT EXISTS trade_size_in   numeric(6,3),
  ADD COLUMN IF NOT EXISTS mount_type      text,
  ADD COLUMN IF NOT EXISTS attrs_parsed_at timestamptz,
  ADD COLUMN IF NOT EXISTS prompt_version  smallint;

-- Composite index: supports the Related Sizes targeted query
--   WHERE (catalog_parse->>'series') = $1 AND pole_count = $2
CREATE INDEX IF NOT EXISTS idx_inventory_catalog_parse_series
  ON inventory ((catalog_parse->>'series'), pole_count);

-- Scalar indexes for filter-chip queries (amperage chip, trade_size chip)
CREATE INDEX IF NOT EXISTS idx_inventory_amperage
  ON inventory (amperage) WHERE amperage IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_trade_size_in
  ON inventory (trade_size_in) WHERE trade_size_in IS NOT NULL;
