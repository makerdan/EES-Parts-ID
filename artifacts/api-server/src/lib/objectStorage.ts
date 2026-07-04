/**
 * Minimal GCS wrapper for server-side image uploads.
 * Uses the Replit sidecar for authentication — do NOT modify the credentials block.
 *
 * The external-account credential shape is typed locally to avoid a direct
 * dependency on google-auth-library (which would conflict with the version
 * already pulled in by @google-cloud/storage).
 */
import type { StorageOptions } from "@google-cloud/storage";
import { Storage } from "@google-cloud/storage";
import { randomUUID } from "crypto";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

/**
 * Minimal local mirror of google-auth-library's ExternalAccountClientOptions.
 * Only the fields required for Replit sidecar auth are included.
 */
interface ExternalAccountCredential {
  type: "external_account";
  audience: string;
  subject_token_type: string;
  token_url: string;
  credential_source: {
    url: string;
    format: { type: string; subject_token_field_name: string };
  };
  universe_domain?: string;
}

const sidecarCredential: ExternalAccountCredential = {
  type: "external_account",
  audience: "replit",
  subject_token_type: "access_token",
  token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
  credential_source: {
    url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
    format: {
      type: "json",
      subject_token_field_name: "access_token",
    },
  },
  universe_domain: "googleapis.com",
};

// The Storage constructor accepts external-account credentials at runtime;
// a single cast to StorageOptions["credentials"] bridges the local interface.
const gcs = new Storage({
  credentials: sidecarCredential as StorageOptions["credentials"],
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

/**
 * Upload a floor plan SVG to GCS under a deterministic well-known path.
 * Overwrites any previous upload. Returns the serving object path.
 */
export async function uploadFloorPlanSvg(svgContent: string): Promise<string> {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

  const privateDir = process.env["PRIVATE_OBJECT_DIR"] ?? "uploads";
  const fullPath = `${privateDir}/floor-plan/warehouse-map.svg`;

  const bucket = gcs.bucket(bucketId);
  const file = bucket.file(fullPath);

  await file.save(Buffer.from(svgContent, "utf8"), {
    contentType: "image/svg+xml",
    resumable: false,
    metadata: { cacheControl: "public, max-age=3600" },
  });

  return `/objects/${fullPath}`;
}

/**
 * Download the floor plan SVG from GCS as a Buffer.
 * objectPath must start with "/objects/".
 */
export async function readFloorPlanSvg(objectPath: string): Promise<Buffer> {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

  const gcsPath = objectPath.replace(/^\/objects\//, "");
  const bucket = gcs.bucket(bucketId);
  const file = bucket.file(gcsPath);
  const [content] = await file.download();
  return content;
}
