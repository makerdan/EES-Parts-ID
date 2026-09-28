// Metro selects this file on web. The disk-backed inventory is native-only:
// importing expo-sqlite from a shared module would pull its WASM worker into
// the browser bundle even when all callers guard on Platform.OS.
import type { InventoryItem } from "@workspace/api-client-react";

export async function offlineSnapshotInfo(): Promise<null> {
  return null;
}

export async function syncOfflineInventory(
  _fetchPage: (page: number, size: number) => Promise<{ items: Array<InventoryItem>; total: number }>,
  _signal: AbortSignal,
  _onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  throw new Error("Disk-backed offline inventory is only available on native devices");
}

export async function searchOfflineInventory(_query: string): Promise<Array<InventoryItem>> {
  throw new Error("Disk-backed offline inventory is only available on native devices");
}

export async function lookupOfflineBarcode(_code: string): Promise<InventoryItem | null> {
  throw new Error("Disk-backed offline inventory is only available on native devices");
}

export async function upsertOfflineItem(_item: InventoryItem): Promise<void> {
  throw new Error("Disk-backed offline inventory is only available on native devices");
}

export async function deleteOfflineItem(_id: number): Promise<void> {
  throw new Error("Disk-backed offline inventory is only available on native devices");
}

export async function hasOfflineItem(_id: number): Promise<boolean> {
  throw new Error("Disk-backed offline inventory is only available on native devices");
}