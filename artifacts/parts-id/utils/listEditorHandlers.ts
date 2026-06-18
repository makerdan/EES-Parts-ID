/**
 * Extracted post-save handler cores for the list-editing screens.
 *
 * Each function encapsulates the remote mutation + list-cache invalidation step
 * that was previously inlined inside useCallback closures in BinEditor,
 * BarcodeEditor, BulkShelfAssign, and ShelfCatalogEntry.  Extracting them:
 *   1. Lets tests verify each call site actually invokes invalidateListCache by
 *      mocking that utility at the module level.
 *   2. Keeps the component callbacks thin — they just bridge component state to
 *      these pure-function cores and handle UI state after awaiting the result.
 */

import type { InventoryItem } from "@workspace/api-client-react";
import { invalidateListCache } from "./editItemCache";
import type { QueryClientLike } from "./editItemCache";

// ─── BinEditor ───────────────────────────────────────────────────────────────

/**
 * Persist updated bin locations for a single inventory item and invalidate
 * every cached list page so the list screen reflects the new value.
 * Returns the server-confirmed item for callers to update local state.
 */
export async function saveBinsAndInvalidate(opts: {
  queryClient: QueryClientLike;
  mutateAsync: (args: {
    id: number;
    data: { binLocations: Array<string> };
  }) => Promise<{ binLocations: Array<string> }>;
  itemId: number;
  bins: Array<string>;
}): Promise<{ binLocations: Array<string> }> {
  const updated = await opts.mutateAsync({
    id: opts.itemId,
    data: { binLocations: opts.bins },
  });
  await invalidateListCache({ queryClient: opts.queryClient });
  return updated;
}

// ─── BarcodeEditor ───────────────────────────────────────────────────────────

/**
 * Persist updated barcodes for a single inventory item and invalidate
 * every cached list page.
 */
export async function saveBarcodesAndInvalidate(opts: {
  queryClient: QueryClientLike;
  mutateAsync: (args: {
    id: number;
    data: { barcodes: Array<string> };
  }) => Promise<{ barcodes: Array<string> }>;
  itemId: number;
  barcodes: Array<string>;
}): Promise<{ barcodes: Array<string> }> {
  const updated = await opts.mutateAsync({
    id: opts.itemId,
    data: { barcodes: opts.barcodes },
  });
  await invalidateListCache({ queryClient: opts.queryClient });
  return updated;
}

// ─── BulkShelfAssign — performAssign ─────────────────────────────────────────

/**
 * Conditionally invalidate the list cache after a bulk-assign operation.
 * Only invalidates when `wasNew` is true (barcode was freshly written to the
 * server, not just re-confirmed from an existing record).
 */
export async function invalidateListIfNew(opts: {
  queryClient: QueryClientLike;
  wasNew: boolean;
}): Promise<void> {
  if (opts.wasNew) {
    await invalidateListCache({ queryClient: opts.queryClient });
  }
}

// ─── BulkShelfAssign — handleUndoAssignment ──────────────────────────────────

/**
 * Remove a previously assigned barcode from an inventory item, persist the
 * change, and invalidate every cached list page.
 * Returns the server-confirmed item for callers to update the offline cache.
 */
export async function undoBarcodeAndInvalidate(opts: {
  queryClient: QueryClientLike;
  mutateAsync: (args: {
    id: number;
    data: { barcodes: Array<string> };
  }) => Promise<InventoryItem>;
  itemId: number;
  currentBarcodes: Array<string>;
  revokedBarcode: string;
}): Promise<InventoryItem> {
  const newBarcodes = opts.currentBarcodes.filter(b => b !== opts.revokedBarcode);
  const updated = await opts.mutateAsync({
    id: opts.itemId,
    data: { barcodes: newBarcodes },
  });
  await invalidateListCache({ queryClient: opts.queryClient });
  return updated;
}

// ─── ShelfCatalogEntry ───────────────────────────────────────────────────────

/**
 * Invalidate the inventory list cache after a new part has been submitted.
 * Thin wrapper so the component's useCallback can be tested via this export.
 */
export async function invalidateInventoryList(opts: {
  queryClient: QueryClientLike;
}): Promise<void> {
  await invalidateListCache(opts);
}
