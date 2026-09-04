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
} as StorageOptions);

const PRIVATE_NAMESPACE = "private";
const CATALOG_IMAGE_NAMESPACE = `${PRIVATE_NAMESPACE}/catalog-images`;
const CATALOG_PDF_STAGING_NAMESPACE = `${PRIVATE_NAMESPACE}/catalog-pdf-staging`;
const PUBLIC_FLOOR_PLAN_NAMESPACE = "public/floor-plan";

function privateObjectDir(): string {
  return (process.env["PRIVATE_OBJECT_DIR"] ?? "uploads").replace(/^\/+|\/+$/g, "");
}

function objectPathToGcsPath(objectPath: string): string {
  if (!objectPath.startsWith("/objects/")) {
    throw new Error("Invalid object path");
  }
  const gcsPath = objectPath.slice("/objects/".length);
  if (!gcsPath || gcsPath.includes("..") || gcsPath.includes("\\") || gcsPath.includes("\0")) {
    throw new Error("Invalid object path");
  }
  return gcsPath;
}

/**
 * Private object paths are deliberately allow-listed. In particular, a path
 * under the public warehouse-map namespace can never be passed to a private
 * delete/read operation, even if a caller accidentally supplies it.
 *
 * The two legacy prefixes are accepted for cleanup and read compatibility with
 * objects written before the namespace hardening. New writes always use the
 * private namespace above.
 */
export function isPrivateObjectPath(objectPath: string): boolean {
  let gcsPath: string;
  try {
    gcsPath = objectPathToGcsPath(objectPath);
  } catch {
    return false;
  }
  const root = `${privateObjectDir()}/`;
  return (
    gcsPath.startsWith(`${root}${PRIVATE_NAMESPACE}/`) ||
    gcsPath.startsWith(`${root}catalog-images/`) ||
    gcsPath.startsWith(`${root}${CATALOG_PDF_STAGING_NAMESPACE.slice(PRIVATE_NAMESPACE.length + 1)}/`)
  );
}

export function isPublicFloorPlanObjectPath(objectPath: string): boolean {
  let gcsPath: string;
  try {
    gcsPath = objectPathToGcsPath(objectPath);
  } catch {
    return false;
  }
  return gcsPath === `${privateObjectDir()}/${PUBLIC_FLOOR_PLAN_NAMESPACE}/warehouse-map.svg`;
}

function requirePrivateObjectPath(objectPath: string): string {
  if (!isPrivateObjectPath(objectPath)) {
    throw new Error("Object is not in a private namespace");
  }
  return objectPathToGcsPath(objectPath);
}

function privateObjectPath(namespace: string, extension: string): string {
  return `/objects/${privateObjectDir()}/${namespace}/${randomUUID()}.${extension}`;
}

/**
 * Upload an image buffer to the private catalog-image namespace and return a
 * controlled object reference. The reference is stored server-side and is
 * never a public bucket URL; clients receive an authenticated API image route.
 */
export async function uploadCatalogImage(
  imageBuffer: Buffer,
  contentType: string = "image/png",
): Promise<string> {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

  const ext = contentType === "image/jpeg" ? "jpg" : "png";
  const objectPath = privateObjectPath(CATALOG_IMAGE_NAMESPACE, ext);
  const fullPath = objectPathToGcsPath(objectPath);

  const bucket = gcs.bucket(bucketId);
  const file = bucket.file(fullPath);

  await file.save(imageBuffer, {
    contentType,
    resumable: false,
    metadata: {
      cacheControl: "private, no-store",
      metadata: { visibility: "authenticated-app", purpose: "catalog-image" },
    },
  });

  return objectPath;
}

/**
 * Upload a floor plan SVG to GCS under the dedicated public layout namespace.
 * Overwrites any previous upload. Returns the serving object path.
 */
export async function uploadFloorPlanSvg(svgContent: string): Promise<string> {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

  const fullPath = `${privateObjectDir()}/${PUBLIC_FLOOR_PLAN_NAMESPACE}/warehouse-map.svg`;

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

  if (!isPublicFloorPlanObjectPath(objectPath)) {
    throw new Error("Object is not a warehouse floor-plan asset");
  }
  const gcsPath = objectPathToGcsPath(objectPath);
  const bucket = gcs.bucket(bucketId);
  const file = bucket.file(gcsPath);
  const [content] = await file.download();
  return content;
}

/** Read a private object after verifying it is in an allow-listed namespace. */
export async function readPrivateObject(objectPath: string): Promise<Buffer> {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

  const bucket = gcs.bucket(bucketId);
  const [content] = await bucket.file(requirePrivateObjectPath(objectPath)).download();
  return content;
}

/**
 * Idempotently delete a private object. Public warehouse-map objects are
 * rejected before a storage call so cleanup can never remove shared map data.
 */
async function deletePrivateObject(objectPath: string | null | undefined): Promise<void> {
  if (!objectPath) return;
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

  const bucket = gcs.bucket(bucketId);
  await bucket.file(requirePrivateObjectPath(objectPath)).delete({ ignoreNotFound: true });
}

/** Delete a set of private objects while tolerating already-cleaned objects. */
export async function deletePrivateObjects(objectPaths: Array<string | null | undefined>): Promise<void> {
  const paths = [...new Set(objectPaths.filter((value): value is string => Boolean(value)))];
  await Promise.all(paths.map((objectPath) => deletePrivateObject(objectPath)));
}

function getCatalogPdfStagingFile(sessionId: string, partIndex: number) {
  if (!/^[0-9a-f-]{20,80}$/i.test(sessionId) || !Number.isSafeInteger(partIndex) || partIndex < 0) {
    throw new Error("Invalid catalog PDF staging key");
  }
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return gcs.bucket(bucketId).file(
    `${privateObjectDir()}/${CATALOG_PDF_STAGING_NAMESPACE}/${sessionId}/${partIndex}.part`,
  );
}

/** Store one upload part under a session-scoped private key. */
export async function writeCatalogPdfPart(
  sessionId: string,
  partIndex: number,
  bytes: Buffer,
): Promise<string> {
  const file = getCatalogPdfStagingFile(sessionId, partIndex);
  await file.save(bytes, {
    contentType: "application/octet-stream",
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { cacheControl: "no-store" },
  });
  return `/objects/${privateObjectDir()}/${CATALOG_PDF_STAGING_NAMESPACE}/${sessionId}/${partIndex}.part`;
}

export async function readCatalogPdfPart(
  sessionId: string,
  partIndex: number,
): Promise<Buffer> {
  const [content] = await getCatalogPdfStagingFile(sessionId, partIndex).download();
  return content;
}

/** Idempotent cleanup; missing objects are already in the desired state. */
export async function deleteCatalogPdfPart(
  sessionId: string,
  partIndex: number,
): Promise<void> {
  try {
    await getCatalogPdfStagingFile(sessionId, partIndex).delete({ ignoreNotFound: true });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 404) throw err;
  }
}
