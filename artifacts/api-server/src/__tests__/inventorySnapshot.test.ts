import { inventorySnapshotHealth } from "../lib/inventorySnapshotHealth";
import { snapshotsToRetain } from "../lib/inventorySnapshotRetention";
import {
  schemaFingerprint,
  serializeInventoryRow,
  stableInventoryRow,
} from "../lib/inventorySnapshotTypes";

describe("inventory snapshot contracts", () => {
  it("serializes the same inventory row deterministically", () => {
    const row = {
      id: 1,
      vendor: "ACME",
      catalog: "A-1",
      orderPurchase: 0,
      orderQuantity: 2,
      totalOpOq: 2,
      description: "",
      binLocations: [],
      aiKeywords: [],
      pinnedKeywords: [],
      barcodes: [],
      enrichedAt: null,
      imageUrl: null,
      thumbnailUrl: null,
      imageUrl2: null,
      thumbnailUrl2: null,
      imageSource: null,
      imageConfidence: null,
      previousDescription: null,
      catalogPdfJobId: null,
      expandedDescription: null,
      size: null,
      dimensions: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as never;
    expect(serializeInventoryRow(row)).toBe(serializeInventoryRow(row));
    expect(stableInventoryRow(row).createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(schemaFingerprint()).toHaveLength(64);
  });

  it("preserves the newest 90 and last-known-good snapshots", () => {
    const snapshots = Array.from({ length: 100 }, (_, index) => ({
      formatVersion: 1,
      snapshotId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      reason: "scheduled" as const,
      sourceEnvironment: "production" as const,
      rowCount: index === 0 ? 10 : 0,
      contentSha256: "x",
      compressedSize: 1,
      dataGeneration: "1",
      dataPath: "/objects/private/inventory-backups/x.jsonl.gz",
      manifestPath: "/objects/private/inventory-backups/x.json",
      schemaFingerprint: schemaFingerprint(),
      exportedFields: [],
      previousValidSnapshotId: null,
      lastKnownGood: index === 0,
      verificationStatus: "verified" as const,
      anomaly: null,
    }));
    const retained = snapshotsToRetain(snapshots, new Date("2026-06-01T00:00:00Z"));
    expect(retained.length).toBeGreaterThanOrEqual(90);
    expect(retained.some((snapshot) => snapshot.lastKnownGood)).toBe(true);
  });

  it("marks an empty latest snapshot as critical", () => {
    const snapshots = [{
      formatVersion: 1,
      snapshotId: "00000000-0000-0000-0000-000000000001",
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "incident-empty" as const,
      sourceEnvironment: "production" as const,
      rowCount: 0,
      contentSha256: "x",
      compressedSize: 1,
      dataGeneration: "1",
      dataPath: "/objects/private/inventory-backups/x.jsonl.gz",
      manifestPath: "/objects/private/inventory-backups/x.json",
      schemaFingerprint: schemaFingerprint(),
      exportedFields: [],
      previousValidSnapshotId: null,
      lastKnownGood: false,
      verificationStatus: "verified" as const,
      anomaly: "empty-inventory" as const,
    }];
    expect(inventorySnapshotHealth(snapshots).status).toBe("critical");
  });
});