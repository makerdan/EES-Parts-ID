import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const CATALOG_PDF_UPLOAD_SESSION_STATUS = [
  "open",
  "completing",
  "completed",
  "cancelled",
  "expired",
  "failed",
] as const;
export type CatalogPdfUploadSessionStatus =
  (typeof CATALOG_PDF_UPLOAD_SESSION_STATUS)[number];

export const catalogPdfUploadSessionTable = pgTable("catalog_pdf_upload_session", {
  id: text("id").primaryKey(),
  ownerClerkUserId: text("owner_clerk_user_id").notNull(),
  vendor: text("vendor").notNull(),
  filename: text("filename").notNull(),
  totalBytes: integer("total_bytes").notNull(),
  partSize: integer("part_size").notNull(),
  partCount: integer("part_count").notNull(),
  fileSha256: text("file_sha256"),
  status: text("status").notNull().default("open"),
  uploadedBytes: integer("uploaded_bytes").notNull().default(0),
  uploadedParts: integer("uploaded_parts").notNull().default(0),
  processingJobId: integer("processing_job_id"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  cleanupAt: timestamp("cleanup_at"),
});

export const catalogPdfUploadPartTable = pgTable(
  "catalog_pdf_upload_part",
  {
    sessionId: text("session_id").notNull(),
    partIndex: integer("part_index").notNull(),
    offset: integer("byte_offset").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    objectPath: text("object_path").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    metadata: jsonb("metadata").$type<{ requestId?: string }>(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.partIndex] })],
);

export type CatalogPdfUploadSession = typeof catalogPdfUploadSessionTable.$inferSelect;
export type CatalogPdfUploadPart = typeof catalogPdfUploadPartTable.$inferSelect;