-- Photo ID telemetry table.
-- One row per /ai/identify call. Records the Vision response shape, routing
-- outcome, top result, and (optionally) the confirmed result when the worker
-- taps "That's it" in the mobile app.

CREATE TABLE IF NOT EXISTS photo_id_event (
  id                   bigserial    PRIMARY KEY,
  ts                   timestamptz  NOT NULL DEFAULT now(),
  image_hash           text,
  vision_raw           jsonb,
  parse_ok             boolean      NOT NULL DEFAULT false,
  catalog_guess        text,
  vendor_guess         text,
  match_type           text,        -- 'catalog_exact' | 'attribute_match' | 'descriptive' | null
  top_result_id        integer,
  confirmed_result_id  integer,
  latency_ms           integer
);

CREATE INDEX IF NOT EXISTS idx_photo_id_event_ts
  ON photo_id_event (ts DESC);
