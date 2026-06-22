-- Persistent cache for AI-generated part card data (display name, specs, cross-refs).
-- Survives server restarts; rows older than 30 days are re-fetched on next access.
CREATE TABLE IF NOT EXISTS "part_card_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"catalog_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_card_cache_catalog_key_unique" UNIQUE("catalog_key")
);
