import { useCallback, useEffect, useState } from "react";
import {
  loadScanHistory,
  saveScanHistory,
  prependEntry,
  clearScanHistory,
  type ScanEntry,
} from "@/utils/scanHistory";

/**
 * Persists barcode scan history across app sessions via AsyncStorage.
 *
 * - history: most-recent-first list of up to 50 entries
 * - addEntry: prepend a new entry (deduplicates by barcode, bubbles to top)
 * - clear: erase all history
 */
export function useScanHistory() {
  const [history, setHistory] = useState<ScanEntry[]>([]);

  useEffect(() => {
    loadScanHistory().then(setHistory).catch(() => {});
  }, []);

  const addEntry = useCallback((entry: ScanEntry) => {
    setHistory((prev) => {
      const next = prependEntry(prev, entry);
      saveScanHistory(next).catch(() => {});
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setHistory([]);
    clearScanHistory().catch(() => {});
  }, []);

  return { history, addEntry, clear };
}
