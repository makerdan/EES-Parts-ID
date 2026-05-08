/**
 * syncInventory — extracted core logic for syncing all inventory items from
 * the API into the local Fuse cache.
 *
 * Keeping this as a standalone async function (rather than inline in a
 * useCallback) makes the two critical behaviours unit-testable:
 *   1. Every inventory-page fetch is issued with `cache: 'no-store'` so
 *      ETags / 304 responses never serve stale data.
 *   2. A second call while a sync is already running returns immediately
 *      without starting a second fetch cycle.
 */

import type { InventoryItem } from '@workspace/api-client-react';

export interface SyncCallbacks {
  setIsSyncing: (v: boolean) => void;
  setSyncProgress: (v: { loaded: number; total: number } | null) => void;
  setSyncError: (v: boolean) => void;
  setSyncRetry: (v: { attempt: number; max: number } | null) => void;
  buildFuseIndex: (items: InventoryItem[]) => void;
}

export interface StorageLike {
  multiSet: (pairs: [string, string][]) => Promise<void>;
}

export const PAGE_SIZE = 1000;
export const PAGE_TIMEOUT_MS = 30_000;
export const MAX_AUTO_RETRIES = 3;

export async function syncAllInventory(opts: {
  apiBase: string;
  syncInFlightRef: { current: boolean };
  callbacks: SyncCallbacks;
  storage: StorageLike;
  fuseKey: string;
  versionKey: string;
  assignmentsKey: string;
  treeKey: string;
  serverVersion?: string;
}): Promise<void> {
  const {
    apiBase,
    syncInFlightRef,
    callbacks,
    storage,
    fuseKey,
    versionKey,
    assignmentsKey,
    treeKey,
    serverVersion,
  } = opts;

  if (syncInFlightRef.current) return;

  callbacks.setSyncError(false);
  callbacks.setSyncRetry(null);
  callbacks.setIsSyncing(true);
  syncInFlightRef.current = true;

  const attemptSync = async () => {
    let page = 1;
    let total = 0;
    const allItems: InventoryItem[] = [];
    do {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${apiBase}/inventory?page=${page}&limit=${PAGE_SIZE}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      const data: { items: InventoryItem[]; total: number } = await res.json();
      if (data.items.length === 0) break;
      total = data.total;
      allItems.push(...data.items);
      callbacks.setSyncProgress({ loaded: allItems.length, total });
      page++;
    } while (allItems.length < total);

    callbacks.buildFuseIndex(allItems);

    // 1. Persist the version key first in a small isolated write.
    //    If this succeeds, subsequent app launches won't re-trigger a full
    //    re-download even if the larger cache write below fails.
    if (serverVersion) {
      await storage.multiSet([[versionKey, serverVersion]]);
    }

    // 2. Build the large cache payload (fuse JSON + category data).
    //    A failure here is swallowed: the in-memory index is already built
    //    and the version key is already saved, so no re-sync loop occurs.
    const cacheOps: [string, string][] = [[fuseKey, JSON.stringify(allItems)]];

    try {
      const aRes = await fetch(`${apiBase}/categories/assignments`);
      if (aRes.ok) {
        const aData = (await aRes.json()) as {
          assignments: { inventoryId: number; typeSlug: string }[];
        };
        const slim = aData.assignments.map((a) => ({
          inventoryId: a.inventoryId,
          typeSlug: a.typeSlug,
        }));
        cacheOps.push([assignmentsKey, JSON.stringify(slim)]);
      }
    } catch {}

    try {
      const tRes = await fetch(`${apiBase}/categories/tree`);
      if (tRes.ok) {
        const tData = (await tRes.json()) as { tree: unknown };
        cacheOps.push([treeKey, JSON.stringify(tData.tree)]);
      }
    } catch {}

    try {
      await storage.multiSet(cacheOps);
    } catch {
      // Quota or write error — tolerated. The in-memory Fuse index built above
      // keeps search working for the current session, and the version key write
      // above means we won't re-sync on the next launch.
    }
  };

  let lastErr: unknown;
  try {
    for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
      if (attempt > 0) {
        callbacks.setSyncRetry({ attempt, max: MAX_AUTO_RETRIES });
        callbacks.setSyncProgress(null);
        await new Promise<void>((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
      try {
        await attemptSync();
        callbacks.setSyncRetry(null);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (lastErr !== undefined) {
      callbacks.setSyncError(true);
    }
  } finally {
    callbacks.setSyncProgress(null);
    callbacks.setSyncRetry(null);
    callbacks.setIsSyncing(false);
    syncInFlightRef.current = false;
  }
}
