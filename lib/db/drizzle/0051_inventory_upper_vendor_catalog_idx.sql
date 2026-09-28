-- Narrow series lookups by normalized vendor and catalog prefix.
CREATE INDEX IF NOT EXISTS inventory_upper_vendor_catalog_idx
  ON inventory (upper(vendor), upper(catalog) text_pattern_ops);