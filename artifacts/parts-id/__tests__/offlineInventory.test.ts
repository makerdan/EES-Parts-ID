import type { InventoryItem } from "@workspace/api-client-react";

import {
  deleteOfflineItem,
  lookupOfflineBarcode,
  offlineSnapshotInfo,
  searchOfflineInventory,
  syncOfflineInventory,
} from "../utils/offlineInventory";

const sqlite = require("expo-sqlite") as { __reset: () => void };
const item = (id: number): InventoryItem => ({
  id, catalog: `PART-${id}`, description: `breaker ${id}`, vendor: "Vendor",
  aiKeywords: [], barcodes: [`CODE-${id}`],
} as unknown as InventoryItem);

beforeEach(() => sqlite.__reset());

it("publishes all 6,001 parts, including the last page, with bounded page sizes", async () => {
  const seen: number[] = [];
  await syncOfflineInventory(async (page, size) => {
    seen.push(size);
    return { total: 6001, items: Array.from({ length: Math.min(size, 6001 - (page - 1) * size) },
      (_, offset) => item((page - 1) * size + offset + 1)) };
  }, new AbortController().signal);
  expect(seen.every(size => size === 200)).toBe(true);
  expect((await offlineSnapshotInfo())?.count).toBe(6001);
  expect((await lookupOfflineBarcode("CODE-6001"))?.id).toBe(6001);
  expect((await searchOfflineInventory("PART-6001")).map(i => i.id)).toContain(6001);
  expect((await searchOfflineInventory("braker 6001")).map(i => i.id)).toContain(6001);
});

it("does not publish a partial generation after an interrupted sync, and drops deleted parts on the next complete sync", async () => {
  await syncOfflineInventory(async (page, size) => ({
    total: 6001,
    items: Array.from({ length: Math.min(size, 6001 - (page - 1) * size) },
      (_, offset) => item((page - 1) * size + offset + 1)),
  }), new AbortController().signal);
  const previous = await offlineSnapshotInfo();
  const abort = new AbortController();
  await expect(syncOfflineInventory(async page => {
    if (page === 2) { abort.abort(); throw new Error("offline"); }
    return { items: [item(7000)], total: 2 };
  }, abort.signal)).rejects.toThrow();
  expect(await offlineSnapshotInfo()).toEqual(previous);
  expect((await lookupOfflineBarcode("CODE-1"))?.id).toBe(1);
  expect(await lookupOfflineBarcode("CODE-7000")).toBeNull();
  await syncOfflineInventory(async () => ({ items: [item(2)], total: 1 }), new AbortController().signal);
  expect(await lookupOfflineBarcode("CODE-1")).toBeNull();
  expect((await lookupOfflineBarcode("CODE-2"))?.id).toBe(2);
  await deleteOfflineItem(2);
  expect(await lookupOfflineBarcode("CODE-2")).toBeNull();
});