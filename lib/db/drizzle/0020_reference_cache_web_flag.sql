ALTER TABLE "reference_answer_cache"
  ADD COLUMN IF NOT EXISTS "used_web_search" boolean NOT NULL DEFAULT false;
