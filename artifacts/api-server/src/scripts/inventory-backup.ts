import { runInventoryBackup } from "../lib/inventorySnapshot";

async function main(): Promise<void> {
  const result = await runInventoryBackup("scheduled");
  console.log(JSON.stringify({
    event: "inventory_snapshot_completed",
    snapshotId: result.manifest.snapshotId,
    rowCount: result.manifest.rowCount,
    anomaly: result.anomaly,
    pruned: result.pruned,
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "inventory_snapshot_failed", error: String(error) }));
  process.exitCode = 1;
});