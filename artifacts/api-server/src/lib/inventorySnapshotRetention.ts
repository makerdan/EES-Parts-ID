import type { InventorySnapshotManifest } from "./inventorySnapshotTypes";
import { deleteInventoryBackupObject } from "./objectStorage";

export function snapshotsToRetain(
  snapshots: ReadonlyArray<InventorySnapshotManifest>,
  now = new Date(),
): Array<InventorySnapshotManifest> {
  const valid = snapshots
    .filter((snapshot) => snapshot.verificationStatus === "verified")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Map<string, InventorySnapshotManifest>();
  for (const snapshot of valid.slice(0, 90)) keep.set(snapshot.snapshotId, snapshot);
  const monthKeys = new Set<string>();
  for (const snapshot of valid) {
    const created = new Date(snapshot.createdAt);
    const ageMonths =
      (now.getUTCFullYear() - created.getUTCFullYear()) * 12 +
      now.getUTCMonth() - created.getUTCMonth();
    if (ageMonths < 12 && monthKeys.size < 12) {
      const month = `${created.getUTCFullYear()}-${String(created.getUTCMonth() + 1).padStart(2, "0")}`;
      if (!monthKeys.has(month)) {
        monthKeys.add(month);
        keep.set(snapshot.snapshotId, snapshot);
      }
    }
  }
  const newest = valid[0];
  if (newest) keep.set(newest.snapshotId, newest);
  const lastKnownGood = valid.find((snapshot) => snapshot.lastKnownGood && snapshot.rowCount > 0);
  if (lastKnownGood) keep.set(lastKnownGood.snapshotId, lastKnownGood);
  return [...keep.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function pruneInventorySnapshots(
  snapshots: ReadonlyArray<InventorySnapshotManifest>,
  now = new Date(),
): Promise<number> {
  const retained = new Set(snapshotsToRetain(snapshots, now).map((snapshot) => snapshot.snapshotId));
  const expired = snapshots.filter((snapshot) => !retained.has(snapshot.snapshotId));
  for (const snapshot of expired) {
    await deleteInventoryBackupObject(snapshot.dataPath);
    await deleteInventoryBackupObject(snapshot.manifestPath);
  }
  return expired.length;
}
