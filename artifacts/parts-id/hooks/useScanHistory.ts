import { useCallback } from "react";

import { useUserHistory } from "@/contexts/UserHistoryContext";

/**
 * Exposes the account-owned scan history to barcode screens.
 *
 * The provider loads and saves history through the authenticated API and
 * clears its in-memory state when the Clerk identity changes or logs out.
 */
export function useScanHistory() {
  const { history, recordScan, clearScans } = useUserHistory();
  const addEntry = useCallback(async (entry: Parameters<typeof recordScan>[0]) => {
    try {
      await recordScan(entry);
    } catch (err) {
      console.error("[useScanHistory] Failed to persist scan history:", err);
    }
  }, [recordScan]);
  const clear = useCallback(() => {
    clearScans().catch((err) => {
      console.error("[useScanHistory] Failed to clear scan history:", err);
    });
  }, [clearScans]);

  return { history: history.scanHistory, addEntry, clear };
}
