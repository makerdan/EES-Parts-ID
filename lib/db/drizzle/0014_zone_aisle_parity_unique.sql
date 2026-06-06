-- Prevent concurrent duplicate writes: no two zones may share the same
-- aisle_id + section_parity combination.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_zone_aisle_parity_idx
  ON warehouse_zone (aisle_id, section_parity);
