/**
 * pdfPickLogger — module-level diagnostic log for the PDF file-pick flow.
 *
 * Lives OUTSIDE React so entries survive component unmount/remount within the
 * same JS bundle session. This is essential for catching "file disappears"
 * bugs caused by re-mounts: you will see LIFECYCLE: unmounted immediately
 * followed by LIFECYCLE: mounted if a re-mount is destroying state.
 *
 * Usage:
 *   logPdfPick("description", optionalData)
 *   getPdfPickLogs()          → readonly LogEntry[]
 *   formatPdfPickLogs()       → human-readable string for copy/paste
 *   clearPdfPickLogs()        → wipe and reset timer
 *   subscribePdfPickLogs(fn)  → returns unsubscribe()
 */

export type LogEntry = {
  seq: number;
  relMs: number;
  msg: string;
  data?: unknown;
};

const _log: Array<LogEntry> = [];
let _seq = 0;
let _originMs: number | null = null;
const _listeners = new Set<() => void>();

export function logPdfPick(msg: string, data?: unknown): void {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (_originMs === null) _originMs = now;
  const entry: LogEntry = {
    seq: ++_seq,
    relMs: Math.round(now - _originMs),
    msg,
    ...(data !== undefined ? { data } : {}),
  };
  _log.push(entry);
  if (data !== undefined) {
    console.log(`[PDF-PICK +${entry.relMs}ms #${entry.seq}]`, msg, data);
  } else {
    console.log(`[PDF-PICK +${entry.relMs}ms #${entry.seq}]`, msg);
  }
  _listeners.forEach(fn => fn());
}

export function getPdfPickLogs(): ReadonlyArray<LogEntry> {
  return _log;
}

export function clearPdfPickLogs(): void {
  _log.length = 0;
  _seq = 0;
  _originMs = null;
  _listeners.forEach(fn => fn());
}

export function formatPdfPickLogs(): string {
  if (_log.length === 0) return "(no entries)";
  return _log
    .map(e => {
      const tag = `+${e.relMs}ms #${e.seq}`;
      const dataStr = e.data !== undefined
        ? "\n    " + JSON.stringify(e.data, null, 2).replace(/\n/g, "\n    ")
        : "";
      return `${tag.padEnd(14)} ${e.msg}${dataStr}`;
    })
    .join("\n");
}

export function subscribePdfPickLogs(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
