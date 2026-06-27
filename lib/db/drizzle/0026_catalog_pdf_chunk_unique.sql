-- Prevent duplicate child jobs for the same (parent_job_id, chunk_index) pair.
--
-- Step 1: Remove any duplicate child rows that may exist due to previous retry
-- behaviour (pre-fix). For each (parent_job_id, chunk_index) slot that has more
-- than one child, keep the single "best" row — most advanced status, then
-- highest processed_pages, then oldest id — and delete the rest.
-- This must run before the unique index to avoid CREATE INDEX failures.
DELETE FROM catalog_pdf_job
WHERE parent_job_id IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (parent_job_id, chunk_index)
      id
    FROM catalog_pdf_job
    WHERE parent_job_id IS NOT NULL
    ORDER BY
      parent_job_id,
      chunk_index,
      -- Prefer the most useful terminal state: done first, then active, then error states.
      CASE status
        WHEN 'done'       THEN 1
        WHEN 'processing' THEN 2
        WHEN 'pending'    THEN 3
        WHEN 'cancelled'  THEN 4
        WHEN 'failed'     THEN 5
        ELSE 6
      END ASC,
      processed_pages DESC,
      id ASC
  );

-- Step 2: Add a partial unique index scoped to child jobs only.
-- Parent and legacy single-upload rows have NULL parent_job_id and are excluded
-- from the constraint, so they are never affected.
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_pdf_job_parent_chunk_uniq"
  ON "catalog_pdf_job" ("parent_job_id", "chunk_index")
  WHERE parent_job_id IS NOT NULL;
