-- Task #2: Barcode → inventory binding table.
--
-- Stores every (scanned-string → inventory_id) mapping the warehouse has
-- ever taught the app. The `source` column lets us distinguish auto-
-- matched catalog hits from worker-linked vendor barcodes from manual
-- admin imports so we can audit the table later.
--
-- The barcode string is the PRIMARY KEY (one canonical row per scan
-- value). Re-linking is performed at the application layer with an
-- explicit `force` flag — the schema simply enforces that exactly one
-- inventory row owns each barcode at any given time.

CREATE TABLE IF NOT EXISTS "inventory_barcode" (
  "barcode"      text PRIMARY KEY NOT NULL,
  "inventory_id" integer NOT NULL,
  "source"       text NOT NULL DEFAULT 'upc-linked',
  "created_at"   timestamp DEFAULT now() NOT NULL,
  "created_by"   text,
  CONSTRAINT "inventory_barcode_inventory_id_fkey"
    FOREIGN KEY ("inventory_id") REFERENCES "inventory"("id") ON DELETE CASCADE,
  CONSTRAINT "inventory_barcode_source_check"
    CHECK ("source" IN ('catalog-auto', 'upc-linked', 'manual'))
);

CREATE INDEX IF NOT EXISTS "inventory_barcode_inventory_idx"
  ON "inventory_barcode" ("inventory_id");
