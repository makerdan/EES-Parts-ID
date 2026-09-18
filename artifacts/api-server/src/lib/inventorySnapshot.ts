import { createHash } from "node:crypto";

import { db, inventoryTable } from "@workspace/db";
import { assertProductionDatabaseTarget } from "@workspace/db/runtime-data-boundary";
import { asc, sql } from "drizzle-orm";

import { readVerifiedSnapshot, writeVerifiedSnapshot } from "./inventorySnapshotStorage";
import {
  assertValidManifest,
  type InventorySnapshotManifest,
  schemaFingerprint,
  serializeInventoryRow,
  type SnapshotReason,
  stableInventoryRow,
} from "./inventorySnapshotTypes";
import { logger } from "./logger";
import { listInventoryBackupManifestPaths, readInventoryBackupObject } from "./objectStorage";

const SNAPSHOT_LOCK = "inventory-snapshot-backup";

export interface SnapshotRunResult {
  manifest: InventorySnapshotManifest;
  anomaly: boolean;
}

export async function withInventorySnapshotLock<T>(
  callback: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SNAPSHOT_LOCK}))`);
    return callback(tx);
  });
}

export async function listVerifiedInventorySnapshots(): Promise<Array<InventorySnapshotManifest>> {
  const manifests: Array<InventorySnapshotManifest> = [];
  for (const path of await listInventoryBackupManifestPaths()) {
    try {
      const value = JSON.parse((await readInventoryBackupObject(path)).toString("utf8")) as unknown;
      assertValidManifest(value);
      await readVerifiedSnapshot(value);
      manifests.push(value);
    } catch (error) {
      logger.warn({ error, path }, "Ignoring invalid inventory snapshot manifest");
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createInventorySnapshot(
  reason: SnapshotReason = "scheduled",
  options: { allowEmptyBaseline?: boolean } = {},
): Promise<SnapshotRunResult> {
  assertProductionDatabaseTarget();
  return withInventorySnapshotLock((tx) => createInventorySnapshotLocked(tx, reason, options));
}

export async function createInventorySnapshotLocked(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  reason: SnapshotReason = "scheduled",
  options: { allowEmptyBaseline?: boolean } = {},
): Promise<SnapshotRunResult> {
    assertProductionDatabaseTarget();
    const rows = await tx.select().from(inventoryTable).orderBy(asc(inventoryTable.id));
    const snapshots = await listVerifiedInventorySnapshots();
    const previous = snapshots[0] ?? null;
    const lastKnownGood = snapshots.find((snapshot) => snapshot.lastKnownGood && snapshot.rowCount > 0) ?? null;
    const anomaly = rows.length === 0 && Boolean(lastKnownGood?.rowCount);
    if (anomaly && !options.allowEmptyBaseline) {
      logger.error({ event: "inventory_snapshot_empty_anomaly", previousSnapshotId: lastKnownGood?.snapshotId }, "Inventory snapshot is unexpectedly empty");
    }
    const serialized = rows.map(serializeInventoryRow).join("");
    const contentSha256 = createHash("sha256").update(serialized).digest("hex");
    const manifest = await writeVerifiedSnapshot(
      rows.map(stableInventoryRow),
      {
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        reason: anomaly ? "incident-empty" : reason,
        sourceEnvironment: "production",
        rowCount: rows.length,
        contentSha256,
        schemaFingerprint: schemaFingerprint(),
        exportedFields: [
          "id", "vendor", "catalog", "orderPurchase", "orderQuantity", "totalOpOq",
          "description", "binLocations", "aiKeywords", "pinnedKeywords", "barcodes",
          "enrichedAt", "imageUrl", "thumbnailUrl", "imageUrl2", "thumbnailUrl2",
          "imageSource", "imageConfidence", "previousDescription", "catalogPdfJobId",
          "expandedDescription", "size", "dimensions", "createdAt", "updatedAt",
        ],
        previousValidSnapshotId: previous?.snapshotId ?? null,
        lastKnownGood: rows.length > 0 || Boolean(options.allowEmptyBaseline),
        anomaly: anomaly ? "empty-inventory" : null,
      },
    );
    return { manifest, anomaly };
}