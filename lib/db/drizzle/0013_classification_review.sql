-- Migration 0013: classification review queue
-- Adds reviewed_at / reviewed_by to inventory_category, plus a partial index
-- covering only the low-confidence AI rows that need human review.

ALTER TABLE inventory_category
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by text NULL;

-- Partial index: only rows eligible for the review queue (ai-classified,
-- not yet reviewed, confidence below 0.70). Ordered by confidence ASC so
-- the least-confident items rise to the top within a page, and classified_at
-- ASC for stable oldest-first pagination.
CREATE INDEX IF NOT EXISTS idx_inventory_category_review_queue
  ON inventory_category (confidence ASC, classified_at ASC)
  WHERE classified_by = 'ai'
    AND reviewed_at IS NULL
    AND confidence < 0.70;
