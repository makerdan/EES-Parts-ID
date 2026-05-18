CREATE TABLE "inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"catalog" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"bin_locations" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"ai_keywords" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"enriched_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse_zone" (
	"id" serial PRIMARY KEY NOT NULL,
	"aisle_id" text NOT NULL,
	"label" text NOT NULL,
	"section_parity" text DEFAULT 'all' NOT NULL,
	"is_inventory" boolean DEFAULT true NOT NULL,
	"svg_x" real NOT NULL,
	"svg_y" real NOT NULL,
	"svg_width" real NOT NULL,
	"svg_height" real NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_zone_section_parity_check" CHECK ("warehouse_zone"."section_parity" IN ('odd', 'even', 'all'))
);
--> statement-breakpoint
CREATE TABLE "abbreviation_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"abbreviation" text NOT NULL,
	"expansions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	CONSTRAINT "abbreviation_map_abbreviation_unique" UNIQUE("abbreviation")
);
--> statement-breakpoint
CREATE TABLE "vendor_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"names" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	CONSTRAINT "vendor_map_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "synonym_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"term" text NOT NULL,
	"synonyms" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	CONSTRAINT "synonym_map_term_unique" UNIQUE("term")
);
--> statement-breakpoint
CREATE TABLE "misspelling_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"misspelling" text NOT NULL,
	"correction" text NOT NULL,
	CONSTRAINT "misspelling_map_misspelling_unique" UNIQUE("misspelling")
);
--> statement-breakpoint
CREATE TABLE "electrical_slang_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"slang_term" text NOT NULL,
	"standard_terms" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	CONSTRAINT "electrical_slang_map_slang_term_unique" UNIQUE("slang_term")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_vendor_catalog_idx" ON "inventory" USING btree ("vendor","catalog");