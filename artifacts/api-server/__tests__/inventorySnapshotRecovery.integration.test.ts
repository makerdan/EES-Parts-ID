jest.mock("../src/lib/objectStorage", () => ({
  listInventoryBackupManifestPaths: jest.fn(async () => []),
  readInventoryBackupObject: jest.fn(async () => Buffer.from("{}")),
}));

jest.mock("../src/lib/inventorySnapshotStorage", () => ({
  readVerifiedSnapshot: jest.fn(),
  writeVerifiedSnapshot: jest.fn(),
}));
jest.mock("@workspace/db/runtime-data-boundary", () => ({
  assertProductionDatabaseTarget: jest.fn(),
  assertDatabaseExecutionMode: jest.fn(),
}));

import { createInventorySnapshotLocked } from "../src/lib/inventorySnapshot";
import { restoreInventoryRowsLocked } from "../src/lib/inventorySnapshotRestore";
import { writeVerifiedSnapshot } from "../src/lib/inventorySnapshotStorage";
import { schemaFingerprint } from "../src/lib/inventorySnapshotTypes";
import { listInventoryBackupManifestPaths, readInventoryBackupObject } from "../src/lib/objectStorage";

describe("inventory snapshot recovery regression", () => {
  it("uses production snapshot classification and locked restore rollback", async () => {
    let currentRows: Array<Record<string, unknown>> = [
      { id: 1, vendor: "ACME", catalog: "A-1", orderPurchase: 1, orderQuantity: 2 },
      { id: 2, vendor: "ACME", catalog: "A-2", orderPurchase: 2, orderQuantity: 3 },
    ];
    const manifests: any[] = [];
    (writeVerifiedSnapshot as jest.Mock).mockImplementation(async (rows, input) => {
      const id = `00000000-0000-4000-8000-${String(manifests.length + 1).padStart(12, "0")}`;
      const manifest = {
        ...input,
        snapshotId: id,
        dataPath: `/objects/private/inventory-backups/${id}.jsonl.gz`,
        manifestPath: `/objects/private/inventory-backups/${id}.json`,
        compressedSize: 1,
        dataGeneration: "1",
        verificationStatus: "verified",
      };
      manifests.push(manifest);
      return manifest;
    });
    const tx = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ orderBy: jest.fn(async () => currentRows) })),
      })),
    } as any;

    const good = await createInventorySnapshotLocked(tx, "scheduled");
    (listInventoryBackupManifestPaths as jest.Mock).mockImplementation(async () => manifests.map((item) => item.manifestPath));
    (readInventoryBackupObject as jest.Mock).mockImplementation(async (path: string) =>
      Buffer.from(JSON.stringify(manifests.find((item) => item.manifestPath === path))));
    currentRows = [];
    const incident = await createInventorySnapshotLocked(tx, "scheduled");
    expect(good.manifest.lastKnownGood).toBe(true);
    expect(incident.anomaly).toBe(true);
    expect(manifests[0].lastKnownGood).toBe(true);

    const restored = [
      { id: 1, vendor: "ACME", catalog: "A-1", description: "", orderPurchase: 1, orderQuantity: 2,
        binLocations: [], aiKeywords: [], pinnedKeywords: [], barcodes: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ];
    let failed = true;
    const restoreTx = {
      delete: jest.fn(async () => { currentRows = []; }),
      insert: jest.fn(() => ({
        values: async () => {
          currentRows = restored;
          if (failed) throw new Error("forced rollback");
        },
      })),
      execute: jest.fn(),
      select: jest.fn((fields: Record<string, unknown>) => ({
        from: jest.fn(async () => "count" in fields ? [{ count: failed ? 0 : 1 }] : [{ orderPurchase: 1, orderQuantity: 2, totalOpOq: 3 }]),
      })),
    } as any;
    await expect(restoreInventoryRowsLocked(restoreTx, restored)).rejects.toThrow("forced rollback");
    failed = false;
    expect(await restoreInventoryRowsLocked(restoreTx, restored)).toBe(1);
    expect(currentRows).toEqual(restored);
    expect(schemaFingerprint()).toHaveLength(64);
  });
});