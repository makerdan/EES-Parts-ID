import type { InventorySnapshotManifest } from "./inventorySnapshotTypes";

export function inventorySnapshotHealth(
  snapshots: ReadonlyArray<InventorySnapshotManifest>,
  now = new Date(),
) {
  const valid = snapshots.filter((snapshot) => snapshot.verificationStatus === "verified")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = valid[0] ?? null;
  const lastKnownGood = valid.find((snapshot) => snapshot.lastKnownGood && snapshot.rowCount > 0) ?? null;
  const ageHours = latest ? (now.getTime() - new Date(latest.createdAt).getTime()) / 3_600_000 : Infinity;
  const critical = Boolean(
    (latest?.anomaly === "empty-inventory") ||
    (!lastKnownGood) ||
    (latest && latest.rowCount === 0 && lastKnownGood.rowCount > 0),
  );
  return {
    status: critical ? "critical" : ageHours > 26 ? "degraded" : "healthy",
    latestSnapshotAt: latest?.createdAt ?? null,
    latestRowCount: latest?.rowCount ?? null,
    lastKnownGoodSnapshotAt: lastKnownGood?.createdAt ?? null,
    lastKnownGoodSnapshotId: lastKnownGood?.snapshotId ?? null,
    emptyInventoryAnomaly: Boolean(latest?.anomaly === "empty-inventory"),
    ageHours: Number.isFinite(ageHours) ? Math.max(0, ageHours) : null,
  } as const;
}