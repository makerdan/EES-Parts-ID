-- Anchor points for the warehouse map affine calibration layer.
-- Stores up to 3 named SVG→world coordinate pairs (id = slot 1, 2, or 3).
-- When all 3 are present, the API computes a full 6-DOF affine transform
-- that replaces the crude origin-anchored translate+scale.
CREATE TABLE IF NOT EXISTS "map_anchor_points" (
  "id"         integer      PRIMARY KEY,
  "name"       text         NOT NULL DEFAULT '',
  "svg_x"      double precision NOT NULL,
  "svg_y"      double precision NOT NULL,
  "world_x"    double precision NOT NULL,
  "world_y"    double precision NOT NULL,
  "updated_at" timestamptz  NOT NULL DEFAULT now()
);
