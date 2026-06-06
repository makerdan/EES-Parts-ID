/**
 * floorPlanCache — two-tier SVG floor-plan cache (memory + AsyncStorage).
 *
 * Tier 1 (in-memory): survives tab switches within the same JS bundle session.
 *   Cleared automatically when the bundle reloads (app update / dev reload).
 *
 * Tier 2 (AsyncStorage, key STORAGE_KEY): survives force-quit and cold
 *   restarts.  The stored entry is keyed by the Expo asset hash so a new
 *   build that ships an updated floor-plan SVG automatically invalidates the
 *   old entry.
 *
 * Call initPersistRead() once at module load time (e.g. as a module-level
 * const in the consuming component) so the AsyncStorage read is in flight
 * before the component mounts.  The returned promise can be awaited inside
 * a useEffect to skip the loading skeleton when data is available.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

/** Tightly-cropped bounding box of the actual floor-plan drawing. */
export interface SvgContentViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SvgData {
  /** Full fetched SVG text (web only; kept for reference). */
  xml: string;
  /**
   * Inner SVG content with the outer <svg> wrapper stripped.
   * Injected via dangerouslySetInnerHTML on web so the floor plan and zone
   * overlays share one SVG viewport (no CSS-transform rasterisation blur).
   */
  innerXml: string;
  /** Resolved local-file URI passed to <SvgUri> on native. */
  uri: string;
  /**
   * Parsed viewBox of the actual warehouse drawing within the SVG coordinate
   * space.  Cached here so the initial viewport can be computed synchronously
   * on repeat cold-starts without re-parsing the XML string.
   * Absent when the SVG has not been parsed yet (e.g. empty fallback entry).
   */
  contentViewBox?: SvgContentViewBox;
}

/** AsyncStorage key for the persisted floor-plan entry. Exported for tests. */
export const STORAGE_KEY = "@rdc34/warehouse_map_svg_v1";

// ── Module-level state ────────────────────────────────────────────────────────
let _cache: SvgData | null = null;
// Hash from the most-recently-stored entry; null when nothing is cached.
let _cachedHash: string | null = null;
// Single in-flight read promise; re-entrant calls return the same promise.
let _readPromise: Promise<void> | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Kick off the AsyncStorage read (idempotent — safe to call many times).
 *
 * Returns a promise that resolves once the read attempt finishes, whether or
 * not data was found.  Call once at module load time in the consumer:
 *
 *   const _persistReadPromise = initPersistRead();
 */
export function initPersistRead(): Promise<void> {
  if (_readPromise) return _readPromise;
  _readPromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (!raw || _cache !== null) return; // nothing stored, or already populated
      try {
        const stored = JSON.parse(raw) as {
          hash: string;
          xml: string;
          innerXml: string;
          uri: string;
          contentViewBox?: SvgContentViewBox;
        };
        // Reject malformed entries — all four string fields are required.
        if (
          typeof stored.hash !== "string" ||
          typeof stored.xml !== "string" ||
          typeof stored.innerXml !== "string" ||
          typeof stored.uri !== "string"
        ) {
          return;
        }
        // Validate contentViewBox if present — must be a numeric quad.
        let contentViewBox: SvgContentViewBox | undefined;
        if (stored.contentViewBox && typeof stored.contentViewBox === "object") {
          const { x, y, w, h } = stored.contentViewBox;
          if (
            typeof x === "number" && isFinite(x) &&
            typeof y === "number" && isFinite(y) &&
            typeof w === "number" && isFinite(w) && w > 0 &&
            typeof h === "number" && isFinite(h) && h > 0
          ) {
            contentViewBox = { x, y, w, h };
          }
        }
        _cachedHash = stored.hash;
        _cache = { xml: stored.xml, innerXml: stored.innerXml, uri: stored.uri, contentViewBox };
      } catch {
        // Corrupted JSON — silently discard; will fall back to network load.
      }
    })
    .catch(() => {}); // Non-fatal — falls back to the normal network load.
  return _readPromise;
}

/**
 * Return the current in-memory cache, regardless of hash.
 * Returns null when no data has been loaded yet.
 */
export function getCachedData(): SvgData | null {
  return _cache;
}

/**
 * Return the cached data only when its stored hash matches `currentHash`.
 * Returns null when there is no cache, or when the hash indicates the cached
 * entry is stale (e.g. a new app build with a different floor-plan SVG).
 */
export function getIfValid(currentHash: string): SvgData | null {
  return _cache !== null && _cachedHash === currentHash ? _cache : null;
}

/** True when any data (including an empty error-fallback) is in memory. */
export function hasCachedData(): boolean {
  return _cache !== null;
}

/**
 * Write data to the in-memory cache and persist it to AsyncStorage.
 * The write is fire-and-forget — a storage failure is non-fatal.
 * Also updates `_cachedHash` so subsequent `getIfValid` calls are correct.
 */
export function setCached(hash: string, data: SvgData): void {
  _cache = data;
  _cachedHash = hash;
  AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ hash, ...data }),
  ).catch(() => {});
}

/**
 * Populate the in-memory cache with an empty fallback entry.
 * Used when the SVG load fails so subsequent mounts skip re-attempting the
 * fetch and immediately render the "Map unavailable" UI.
 * Does NOT write to AsyncStorage — a transient load failure should not
 * permanently cache an empty state.
 */
export function setFallbackEmpty(): void {
  if (_cache !== null) return; // don't overwrite valid cached data
  _cache = { xml: "", innerXml: "", uri: "" };
}

// ── Test helpers ──────────────────────────────────────────────────────────────
// Prefixed with underscore to signal internal-only use.

/**
 * Invalidate the in-memory cache and reset the read promise so a subsequent
 * `loadSvgAsset()` call triggers a fresh server fetch.
 *
 * Call this when the server reports a new floor-plan hash while the app is
 * running (ETag-style live-update detection in WarehouseMapView).  The
 * AsyncStorage entry is intentionally left intact so a crash during the
 * re-fetch falls back to the previous version on the next cold start.
 */
export function resetForServerUpdate(): void {
  _cache = null;
  _cachedHash = null;
  // Replace the pending read promise with an already-resolved one so the
  // next SVG load effect does not block waiting for a stale AsyncStorage read.
  _readPromise = Promise.resolve();
}

/** Reset all module state.  Call in beforeEach() in unit tests. */
export function _resetForTests(): void {
  _cache = null;
  _cachedHash = null;
  _readPromise = null;
}
