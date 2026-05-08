-- 0016_chip_filter_composite_indexes.sql
-- Telemetry-driven composite partial indexes for chip filter columns
--
-- Analysis method
-- ───────────────
-- Ran against search_event.filters_json (157 events in dev, 133 with non-empty
-- filters_json). All 133 events stored the full filter object with every key
-- set to "" (empty string) — no real chip filter combinations have been applied
-- in this dev environment yet. Index selection therefore falls back to:
--
--   1. Cardinality analysis on the inventory filter columns:
--        amperage       82 distinct values, 1 281 non-null  (HIGH selectivity)
--        trade_size_in 164 distinct values, 1 467 non-null  (HIGHEST selectivity)
--        voltage         9 distinct values,   724 non-null  (low — excluded standalone)
--        pole_count      4 distinct values,   462 non-null  (low — excluded standalone)
--        mount_type      5 distinct values,   106 non-null  (low — excluded standalone)
--
--   2. Column co-occurrence counts (rows where both columns are non-null):
--        amperage + pole_count              386 rows (5.2 % of table)
--        amperage + voltage                 516 rows (7.0 % of table)
--        amperage + pole_count + voltage    269 rows (3.6 % of table)
--        trade_size_in + mount_type          23 rows (0.3 % of table)
--
--   3. Domain knowledge: workers look up circuit breakers by amp + pole count,
--      panel equipment by amp + voltage, and conduit fittings by trade size.
--
-- Explicitly excluded (low-cardinality-only combinations)
-- ────────────────────────────────────────────────────────
-- pole_count-only     — 4 distinct values; planner skips B-tree below ~5 %
--                        selectivity threshold
-- voltage-only        — 9 distinct values; similar cardinality argument
-- mount_type-only     — 5 distinct values, only 106 non-null rows; index cost
--                        exceeds benefit vs. heap scan
-- pole_count + voltage — both low-cardinality; combined selectivity still
--                        insufficient to beat a seq-scan on 462 / 724 non-null
--                        rows without a high-selectivity anchor column
--
-- Per-column scalar indexes (idx_inventory_amperage, idx_inventory_trade_size_in)
-- were created in migration 0010_materialized_attrs.sql and are retained for
-- single-column queries. The composite indexes below target multi-column
-- combinations that appear together in chip-filtered searches.

-- Index 1: amperage + pole_count
-- ─────────────────────────────
-- Targets "20A 2-pole breaker" style searches — the most natural breaker lookup
-- pattern (amp rating + pole count). Replaces the BitmapAnd between
-- idx_inventory_amperage and the catalog_parse_series index's pole_count
-- component with a single composite scan.
-- Co-occurrence frequency (dev inventory): 386 rows.
CREATE INDEX IF NOT EXISTS idx_inventory_amp_pole
  ON inventory (amperage, pole_count)
  WHERE amperage IS NOT NULL AND pole_count IS NOT NULL;

-- Index 2: amperage + voltage
-- ──────────────────────────
-- Targets "20A 240V breaker" / "20A 120V GFCI" style searches — panel and
-- breaker lookups that combine an amperage rating with a voltage rating.
-- Baseline EXPLAIN showed: idx_inventory_amperage scan + heap filter for
-- voltage (no voltage index). This composite eliminates the heap filter.
-- Co-occurrence frequency (dev inventory): 516 rows.
CREATE INDEX IF NOT EXISTS idx_inventory_amp_volt
  ON inventory (amperage, voltage)
  WHERE amperage IS NOT NULL AND voltage IS NOT NULL;

-- Index 3: amperage + pole_count + voltage
-- ─────────────────────────────────────────
-- Targets fully-specified breaker lookups ("20A 2-pole 240V breaker").
-- When all three chip filters are active simultaneously, this index returns
-- the candidate set with a single scan instead of a BitmapAnd chain.
-- The planner will prefer this over indexes 1 and 2 when all three predicates
-- are present, and fall back to 1 or 2 for partial combinations.
-- Co-occurrence frequency (dev inventory): 269 rows.
CREATE INDEX IF NOT EXISTS idx_inventory_amp_pole_volt
  ON inventory (amperage, pole_count, voltage)
  WHERE amperage IS NOT NULL AND pole_count IS NOT NULL AND voltage IS NOT NULL;

-- Index 4: trade_size_in + mount_type
-- ─────────────────────────────────────
-- Targets conduit fitting lookups that combine trade size with mounting style
-- (e.g. "1/2\" bolt-on connector"). trade_size_in is the most selective
-- single column (164 distinct values); adding mount_type (5 values) creates
-- a composite that precisely targets fitting / box-connector rows.
-- Co-occurrence frequency (dev inventory): 23 rows — the tiny partial index
-- is essentially free to maintain and sub-millisecond to scan.
CREATE INDEX IF NOT EXISTS idx_inventory_tsi_mount
  ON inventory (trade_size_in, mount_type)
  WHERE trade_size_in IS NOT NULL AND mount_type IS NOT NULL;
