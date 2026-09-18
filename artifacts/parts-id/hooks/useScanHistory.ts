import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearScanHistory,
  loadScanHistory,
  prependEntry,
  saveScanHistory,
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
  const [history, setHistory] = useState<Array<ScanEntry>>([]);
  // Ref keeps addEntry's closure stable (no dep on history) while always
  // seeing the latest list so prependEntry deduplicates correctly.
  const historyRef = useRef<Array<ScanEntry>>([]);

  useEffect(() => {
    loadScanHistory().then((loaded) => {
      historyRef.current = loaded;
      setHistory(loaded);
    }).catch(() => {});
  }, []);

  const addEntry = useCallback(async (entry: ScanEntry) => {
    const next = prependEntry(historyRef.current, entry);
    historyRef.current = next;
    setHistory(next);
    try {
      await saveScanHistory(next);
    } catch (err) {
      console.error("[useScanHistory] Failed to persist scan history:", err);
    }
  }, []);

  const clear = useCallback(() => {
    historyRef.current = [];
    setHistory([]);
    clearScanHistory().catch(() => {});
  }, []);

  return { history, addEntry, clear };
}
