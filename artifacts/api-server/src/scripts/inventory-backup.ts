import { assertProductionDatabaseTarget } from "@workspace/db/runtime-data-boundary";

import { createInventorySnapshot, listVerifiedInventorySnapshots } from "../lib/inventorySnapshot";
import { pruneInventorySnapshots } from "../lib/inventorySnapshotRetention";

async function main(): Promise<void> {
  assertProductionDatabaseTarget();
  if (!process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || !process.env.PRIVATE_OBJECT_DIR) {
    throw new Error("Private App Storage configuration is required for inventory backups");
  }
  const result = await createInventorySnapshot("scheduled");
  const pruned = await pruneInventorySnapshots(await listVerifiedInventorySnapshots());
  console.log(JSON.stringify({
    event: "inventory_snapshot_completed",
    snapshotId: result.manifest.snapshotId,
    rowCount: result.manifest.rowCount,
    anomaly: result.anomaly,
    pruned,
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "inventory_snapshot_failed", error: String(error) }));
  process.exitCode = 1;
});