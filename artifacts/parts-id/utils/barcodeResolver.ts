/**
 * Pure orchestration helpers for barcode look-up and shelf assignment.
 * Extracted from BarcodeScreen so the business logic is unit-testable without
 * rendering the component.
 */
import { lookupByBarcode } from "@workspace/api-client-react";
import type { InventoryItem } from "@workspace/api-client-react";
import { lookupByBarcodeOffline } from "@/utils/offlineBarcode";

// ── Barcode resolution ────────────────────────────────────────────────────────

export type BarcodeResolution =
  /** Online API lookup succeeded. */
  | { phase: "found"; item: InventoryItem; isOffline: false }
  /** API unreachable — matched an item in the local cache. */
  | { phase: "found"; item: InventoryItem; isOffline: true }
  /** API returned 404 — barcode is unknown to the server. */
  | { phase: "notfound" }
  /** API unreachable AND the barcode is not in the local cache. */
  | { phase: "offline_miss" }
  /** API returned a non-404 HTTP error. */
  | { phase: "error"; message: string };

/**
 * Resolve a scanned barcode to an inventory item.
 *
 * Priority order:
 * 1. Online API lookup via `lookupByBarcode`
 * 2. Local offline cache via `lookupByBarcodeOffline` (only when network is unreachable)
 *
 * A 404 from the server is returned as `{ phase: "notfound" }` even when the
 * barcode exists in the local cache — this guards against showing stale data for
 * items that have been deleted server-side.
 */
export async function resolveBarcodeCode(code: string): Promise<BarcodeResolution> {
  try {
    const item = await lookupByBarcode(encodeURIComponent(code));
    return { phase: "found", item, isOffline: false };
  } catch (err: unknown) {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status: number }).status
        : null;

    if (status === 404) {
      // Server confirmed this barcode is unknown — do NOT fall back to the local
      // cache, as the item may have been deleted since the cache was last refreshed.
      return { phase: "notfound" };
    }

    if (status === null) {
      // Network unreachable — try the local cache.
      const offlineItem = await lookupByBarcodeOffline(code);
      if (offlineItem) {
        return { phase: "found", item: offlineItem, isOffline: true };
      }
      return { phase: "offline_miss" };
    }

    return { phase: "error", message: "Lookup failed — please try again." };
  }
}

// ── Shelf assignment ──────────────────────────────────────────────────────────

export type ShelfAssignResult =
  | { wasNew: true; updatedItem: InventoryItem }
  | { wasNew: false };

/**
 * Assign `barcode` to `item`, updating both the remote API and the local
 * offline cache.  If the barcode is already listed on the item, this is a
 * no-op and `{ wasNew: false }` is returned.
 *
 * @param updateBarcodes  Calls the remote update endpoint; must return the
 *                        server's authoritative copy of the updated item.
 * @param upsertCache     Persists the updated item to the local offline cache.
 */
export async function resolveShelfAssign(
  barcode: string,
  item: InventoryItem,
  updateBarcodes: (id: number, barcodes: string[]) => Promise<InventoryItem>,
  upsertCache: (item: InventoryItem) => Promise<void>,
): Promise<ShelfAssignResult> {
  const existing = item.barcodes ?? [];
  if (existing.includes(barcode)) {
    return { wasNew: false };
  }
  const updated = await updateBarcodes(item.id, [...existing, barcode]);
  await upsertCache(updated);
  return { wasNew: true, updatedItem: updated };
}
