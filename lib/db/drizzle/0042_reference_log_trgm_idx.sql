-- Keep bounded admin AI-log substring searches index-backed as retained
-- history grows. The ask-log route uses ILIKE '%term%' on both columns,
-- which pg_trgm accelerates with these GIN indexes.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "reference_log_question_trgm_idx"
  ON "reference_log" USING GIN ("question" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "reference_log_answer_trgm_idx"
  ON "reference_log" USING GIN ("answer" gin_trgm_ops);