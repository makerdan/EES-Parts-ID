import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createGzip,gunzipSync } from "node:zlib";

import {
  assertValidManifest,
  type InventorySnapshotManifest,
} from "./inventorySnapshotTypes";
import {
  getInventoryBackupPaths,
  readInventoryBackupObject,
  writeInventoryBackupObject,
  writeInventoryBackupStream,
} from "./objectStorage";

export interface SnapshotObject {
  manifest: InventorySnapshotManifest;
  rows: Array<Record<string, unknown>>;
}

export async function writeVerifiedSnapshot(
  rows: Array<Record<string, unknown>>,
  manifestInput: Omit<InventorySnapshotManifest, "snapshotId" | "dataPath" | "manifestPath" | "compressedSize" | "dataGeneration" | "verificationStatus">,
): Promise<InventorySnapshotManifest> {
  const snapshotId = randomUUID();
  const paths = getInventoryBackupPaths(snapshotId);
  const hash = createHash("sha256");
  function* lines(): Generator<string> {
    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      hash.update(line);
      yield line;
    }
  }
  const data = await writeInventoryBackupStream(
    paths.dataPath,
    Readable.from(lines()).pipe(createGzip({ level: 9 })),
    "application/gzip",
    { purpose: "inventory-snapshot-data", snapshotId },
  );
  const manifest: InventorySnapshotManifest = {
    ...manifestInput,
    snapshotId,
    dataPath: paths.dataPath,
    manifestPath: paths.manifestPath,
    compressedSize: data.size,
    dataGeneration: data.generation,
    contentSha256: hash.digest("hex"),
    verificationStatus: "verified",
  };
  assertValidManifest(manifest);
  await writeInventoryBackupObject(
    paths.manifestPath,
    Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    "application/json",
    { purpose: "inventory-snapshot-manifest", snapshotId },
  );
  return manifest;
}

export async function readVerifiedSnapshot(manifest: InventorySnapshotManifest): Promise<SnapshotObject> {
  assertValidManifest(manifest);
  const content = gunzipSync(await readInventoryBackupObject(manifest.dataPath));
  if (createHash("sha256").update(content).digest("hex") !== manifest.contentSha256) {
    throw new Error("Inventory snapshot checksum mismatch");
  }
  const rows = content.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (rows.length !== manifest.rowCount) throw new Error("Inventory snapshot row count mismatch");
  return { manifest, rows };
}