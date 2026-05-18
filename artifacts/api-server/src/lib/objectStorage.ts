/**
 * Minimal GCS wrapper for server-side image uploads.
 * Uses the Replit sidecar for authentication — do NOT modify the credentials block.
 */
import { Storage } from "@google-cloud/storage";
import { randomUUID } from "crypto";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const gcs = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as any,
  projectId: "",
});

/**
 * Upload an image buffer to GCS and return the public-serving object path.
 * Returns a path like "/objects/catalog-images/<uuid>.png" which callers
 * should store in the database and serve via the storage endpoint.
 */
export async function uploadCatalogImage(
  imageBuffer: Buffer,
  contentType: string = "image/png",
): Promise<string> {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

  const privateDir = process.env["PRIVATE_OBJECT_DIR"] ?? "uploads";
  const ext = contentType === "image/jpeg" ? "jpg" : "png";
  const filename = `catalog-images/${randomUUID()}.${ext}`;
  const fullPath = `${privateDir}/${filename}`;

  const bucket = gcs.bucket(bucketId);
  const file = bucket.file(fullPath);

  await file.save(imageBuffer, {
    contentType,
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000" },
  });

  return `/objects/${fullPath}`;
}
