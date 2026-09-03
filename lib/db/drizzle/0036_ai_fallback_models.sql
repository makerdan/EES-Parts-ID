ALTER TABLE "admin_preferences"
  ADD COLUMN IF NOT EXISTS "ai_fallback_models" jsonb;