import { createHash } from "node:crypto";

import type { Inventory } from "@workspace/db";

const SNAPSHOT_FORMAT_VERSION = 1;
const SNAPSHOT_FIELDS = [
  "id", "vendor", "catalog", "orderPurchase", "orderQuantity", "totalOpOq",
  "description", "binLocations", "aiKeywords", "pinnedKeywords", "barcodes",
  "enrichedAt", "imageUrl", "thumbnailUrl", "imageUrl2", "thumbnailUrl2",
  "imageSource", "imageConfidence", "previousDescription", "catalogPdfJobId",
  "expandedDescription", "size", "dimensions", "createdAt", "updatedAt",
] as const;

export type SnapshotReason = "scheduled" | "pre-import" | "pre-delete" | "pre-restore" | "incident-empty";

export interface InventorySnapshotManifest {
  formatVersion: number;
  snapshotId: string;
  createdAt: string;
  reason: SnapshotReason;
  sourceEnvironment: "production";
  rowCount: number;
  contentSha256: string;
  compressedSize: number;
  dataGeneration: string;
  dataPath: string;
  manifestPath: string;
  schemaFingerprint: string;
  exportedFields: ReadonlyArray<string>;
  previousValidSnapshotId: string | null;
  lastKnownGood: boolean;
  verificationStatus: "verified";
  anomaly: "empty-inventory" | null;
}

export function stableInventoryRow(row: Inventory): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of SNAPSHOT_FIELDS) {
    const value = row[field as keyof Inventory];
    output[field] = value instanceof Date ? value.toISOString() : value;
  }
  return output;
}

export function serializeInventoryRow(row: Inventory): string {
  return `${JSON.stringify(stableInventoryRow(row))}\n`;
}

export function schemaFingerprint(): string {
  return createHash("sha256").update(SNAPSHOT_FIELDS.join("\n")).digest("hex");
}

export function assertValidManifest(value: unknown): asserts value is InventorySnapshotManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid inventory snapshot manifest");
  const manifest = value as Partial<InventorySnapshotManifest>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const sha256 = /^[0-9a-f]{64}$/i;
  const reasons: ReadonlyArray<SnapshotReason> = ["scheduled", "pre-import", "pre-delete", "pre-restore", "incident-empty"];
  const fieldsMatch = JSON.stringify(manifest.exportedFields) === JSON.stringify(SNAPSHOT_FIELDS);
  const compressedSize = manifest.compressedSize;
  const previousValidSnapshotId = manifest.previousValidSnapshotId;
  const privatePath = (path: unknown): path is string =>
    typeof path === "string" && path.startsWith("/objects/") && path.includes("/private/inventory-backups/");
  if (
    manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION ||
    typeof manifest.snapshotId !== "string" || !uuid.test(manifest.snapshotId) ||
    typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    typeof manifest.reason !== "string" || !reasons.includes(manifest.reason) ||
    manifest.sourceEnvironment !== "production" ||
    manifest.verificationStatus !== "verified" ||
    !Number.isSafeInteger(manifest.rowCount) ||
    typeof manifest.contentSha256 !== "string" || !sha256.test(manifest.contentSha256) ||
    !Number.isSafeInteger(compressedSize) || compressedSize == null || compressedSize <= 0 ||
    typeof manifest.dataGeneration !== "string" || manifest.dataGeneration.length === 0 ||
    !privatePath(manifest.dataPath) || !privatePath(manifest.manifestPath) ||
    !manifest.dataPath.endsWith(`/${manifest.snapshotId}.jsonl.gz`) ||
    !manifest.manifestPath.endsWith(`/${manifest.snapshotId}.json`) ||
    manifest.schemaFingerprint !== schemaFingerprint() || !fieldsMatch ||
    (previousValidSnapshotId !== null && previousValidSnapshotId !== undefined && !uuid.test(previousValidSnapshotId)) ||
    (manifest.anomaly !== null && manifest.anomaly !== "empty-inventory") ||
    typeof manifest.lastKnownGood !== "boolean"
  ) throw new Error("Invalid or incompatible inventory snapshot manifest");
}