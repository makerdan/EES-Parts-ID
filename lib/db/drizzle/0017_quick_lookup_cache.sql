-- Migration 0017: quick_lookup_cache
--
-- Stores pre-generated AI answers for the 12 canonical Quick Lookup chips
-- displayed in the Reference modal. The API server seeds / refreshes all
-- 12 rows on startup (skipping any row fresher than 30 days) so the mobile
-- client can pre-load every answer the moment the modal opens — making chip
-- taps instant with no loading spinner.

CREATE TABLE IF NOT EXISTS quick_lookup_cache (
  id           serial      PRIMARY KEY,
  label        text        NOT NULL UNIQUE,
  question     text        NOT NULL,
  answer       text        NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
