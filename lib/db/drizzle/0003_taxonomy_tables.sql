-- Browse-by-Category taxonomy (Task #100)
--
-- Three-level tree (category → subcategory → type) and a join table that
-- maps each inventory row to one type-level node with a confidence score
-- and a "source" so admin overrides survive re-classification runs.

CREATE TABLE IF NOT EXISTS "category_node" (
  "id"          serial PRIMARY KEY,
  "parent_id"   integer REFERENCES "category_node"("id") ON DELETE CASCADE,
  "level"       text NOT NULL,
  "name"        text NOT NULL,
  "slug"        text NOT NULL UNIQUE,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "source"      text NOT NULL DEFAULT 'seed',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "category_node_parent_idx" ON "category_node" ("parent_id");
CREATE INDEX IF NOT EXISTS "category_node_level_idx"  ON "category_node" ("level");

CREATE TABLE IF NOT EXISTS "inventory_category" (
  "inventory_id"      integer NOT NULL REFERENCES "inventory"("id") ON DELETE CASCADE,
  "category_node_id"  integer NOT NULL REFERENCES "category_node"("id") ON DELETE CASCADE,
  "confidence"        numeric(5,4) NOT NULL DEFAULT '1.0000',
  "classified_by"     text NOT NULL DEFAULT 'rule',
  "classified_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("inventory_id", "category_node_id")
);

CREATE INDEX IF NOT EXISTS "inventory_category_inv_idx"  ON "inventory_category" ("inventory_id");
CREATE INDEX IF NOT EXISTS "inventory_category_node_idx" ON "inventory_category" ("category_node_id");
