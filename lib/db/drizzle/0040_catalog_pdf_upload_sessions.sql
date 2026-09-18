-- Durable, private staging manifest for catalog PDF uploads.
-- The processing-job table remains the source of truth for extraction only.
CREATE TABLE IF NOT EXISTS "catalog_pdf_upload_session" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_clerk_user_id" text NOT NULL,
  "vendor" text NOT NULL,
  "filename" text NOT NULL,
  "total_bytes" integer NOT NULL,
  "part_size" integer NOT NULL,
  "part_count" integer NOT NULL,
  "file_sha256" text,
  "status" text DEFAULT 'open' NOT NULL,
  "uploaded_bytes" integer DEFAULT 0 NOT NULL,
  "uploaded_parts" integer DEFAULT 0 NOT NULL,
  "processing_job_id" integer,
  "error_code" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp NOT NULL,
  "cleanup_at" timestamp
);

CREATE INDEX IF NOT EXISTS "catalog_pdf_upload_session_owner_idx"
  ON "catalog_pdf_upload_session" ("owner_clerk_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "catalog_pdf_upload_session_expiry_idx"
  ON "catalog_pdf_upload_session" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "catalog_pdf_upload_part" (
  "session_id" text NOT NULL,
  "part_index" integer NOT NULL,
  "byte_offset" integer NOT NULL,
  "byte_length" integer NOT NULL,
  "sha256" text NOT NULL,
  "object_path" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "metadata" jsonb,
  PRIMARY KEY ("session_id", "part_index")
);

CREATE INDEX IF NOT EXISTS "catalog_pdf_upload_part_session_idx"
  ON "catalog_pdf_upload_part" ("session_id", "part_index");