/**
 * pdfPickLogger — module-level diagnostic log for the PDF file-pick flow.
 *
 * Lives OUTSIDE React so entries survive component unmount/remount within the
 * same JS bundle session. Also persists to sessionStorage so entries survive
 * Expo HMR-triggered full page reloads (common in the Replit dev environment
 * where Metro's CORS rejection causes the HMR client to hard-reload the page).
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

const SESSION_KEY = "pdfPickLogger_v1";

// ── sessionStorage helpers (no-op on native where sessionStorage is absent) ──

function _ssAvailable(): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage !== null;
  } catch {
    return false;
  }
}

function _ssLoad(): Array<LogEntry> {
  if (!_ssAvailable()) return [];
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Array<LogEntry>;
  } catch {
    return [];
  }
}

function _ssSave(log: Array<LogEntry>): void {
  if (!_ssAvailable()) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(log));
  } catch {
    // ignore quota errors
  }
}

function _ssClear(): void {
  if (!_ssAvailable()) return;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

// ── Module state — restored from sessionStorage on load ───────────────────────

const _log: Array<LogEntry> = _ssLoad();
let _seq = _log.length > 0 ? (_log[_log.length - 1]?.seq ?? 0) : 0;
let _originMs: number | null = null;   // always relative within the current session
const _listeners = new Set<() => void>();

// If we restored entries from a previous session, annotate the first one
if (_log.length > 0 && _log[0]?.msg !== "--- page reloaded; log restored from sessionStorage ---") {
  const reloadEntry: LogEntry = {
    seq: 0,
    relMs: 0,
    msg: "--- page reloaded; log restored from sessionStorage ---",
  };
  _log.unshift(reloadEntry);
}

// ── Public API ─────────────────────────────────────────────────────────────────

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
  _ssSave(_log);
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
  _ssClear();
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
