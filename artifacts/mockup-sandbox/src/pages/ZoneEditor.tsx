/**
 * Zone Editor — DEV-ONLY internal tool for Daniel to visually draw warehouse
 * zone boundaries on top of the floor plan SVG. Zones are saved directly to the
 * warehouse_zone DB table via the local API server.
 *
 * Interaction model:
 *   Pan mode  : drag background to pan, scroll wheel to zoom
 *   Draw mode : click+drag background to draw a new rectangle, then fill form
 *   Select    : click any zone → populates sidebar form
 *               Shift+click zone or list item → add/remove from multi-selection
 *               Shift+drag background → rubber-band rectangle select
 *   Move      : drag selected zone (single-select only) → PATCH on drop
 *   Resize    : drag corner handles of selected zone (single-select only) → PATCH on drop
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Toaster, toast } from "sonner";
import { computeWheelZoom } from "../utils/wheelZoom";
import { normRect as normRectUtil } from "../utils/rubberBandSelect";
import { screenToSvg } from "../utils/svgCoords";
import { useRubberBand } from "../hooks/useRubberBand";
import { isValidAisleId, findDuplicateConflict, normalizeAisleId, type ZoneLike } from "@workspace/zone-validation";
import warehouseMapFallback from "../../public/warehouse-map.svg?raw";

// Strip the outer <svg> wrapper so the inner content can be embedded directly
// inside the main SVG canvas <g>, sharing the same coordinate space.
function extractSvgInner(svgRaw: string): string {
  return svgRaw
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
}

// Extract the natural dimensions (viewBox or width/height) from a raw SVG string
// so the rasterizer can render it at the correct aspect ratio.
function extractSvgDims(svgRaw: string): { w: number; h: number } {
  const vbMatch = svgRaw.match(/viewBox\s*=\s*["']([^"']+)["']/);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] };
    }
  }
  const wMatch = svgRaw.match(/\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)["']?/);
  const hMatch = svgRaw.match(/\bheight\s*=\s*["']?(\d+(?:\.\d+)?)["']?/);
  const w = wMatch ? parseFloat(wMatch[1]) : 2000;
  const h = hMatch ? parseFloat(hMatch[1]) : 1000;
  return { w, h };
}

const svgFallbackInner = extractSvgInner(warehouseMapFallback);
const svgFallbackDims = extractSvgDims(warehouseMapFallback);

// ── Flood-fill helpers (module-level, no React deps) ──────────────────────────

// Cache keyed on svgInner string to avoid re-rasterizing on every click.
let _rasterCache: { key: string; imageData: ImageData; w: number; h: number } | null = null;

async function rasterizeSvg(
  svgInner: string,
  dims: { w: number; h: number },
): Promise<{ imageData: ImageData; w: number; h: number }> {
  if (_rasterCache && _rasterCache.key === svgInner) {
    return { imageData: _rasterCache.imageData, w: _rasterCache.w, h: _rasterCache.h };
  }
  // Render at up to 1024 px wide to keep memory and processing time bounded.
  const maxPx = 1024;
  const aspect = dims.h / dims.w;
  const cw = Math.min(Math.round(dims.w), maxPx);
  const ch = Math.max(1, Math.round(cw * aspect));

  const svgStr = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
    ` viewBox="0 0 ${dims.w} ${dims.h}" width="${cw}" height="${ch}">`,
    svgInner,
    `</svg>`,
  ].join("");

  const blob = new Blob([svgStr], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error("No 2D canvas context")); return; }
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const imageData = ctx.getImageData(0, 0, cw, ch);
      _rasterCache = { key: svgInner, imageData, w: cw, h: ch };
      resolve({ imageData, w: cw, h: ch });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to rasterize floor plan SVG")); };
    img.src = url;
  });
}

// BFS flood fill returning the pixel bounding box of the connected light region.
// Returns null if the seed pixel is dark (i.e. user clicked on a wall).
export function floodFillBounds(
  imageData: ImageData,
  startX: number,
  startY: number,
  darkThreshold = 200,
): { x: number; y: number; w: number; h: number } | null {
  const { data, width, height } = imageData;

  const isLight = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const i = (y * width + x) * 4;
    const a = data[i + 3];
    if (a < 128) return false; // transparent pixels treated as walls (background outside floor plan)
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum >= darkThreshold;
  };

  if (!isLight(startX, startY)) return null;

  const visited = new Uint8Array(width * height);
  // Use a flat integer stack (pos = y * width + x) with push/pop (O(1) dequeue).
  const stack: number[] = [];
  const seedPos = startY * width + startX;
  visited[seedPos] = 1;
  stack.push(seedPos);

  let minX = startX, maxX = startX, minY = startY, maxY = startY;

  while (stack.length > 0) {
    const pos = stack.pop()!;
    const x = pos % width;
    const y = (pos / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    const neighbors: [number, number][] = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const vi = ny * width + nx;
        if (!visited[vi] && isLight(nx, ny)) {
          visited[vi] = 1;
          stack.push(vi);
        }
      }
    }
  }

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const HANDLE_PX = 6; // handle visual size in screen pixels

// Preset sensitivity levels. Each has:
//   pos       — position on the 0-100 slider (evenly distributed)
//   label     — full user-facing name
//   short     — abbreviated label shown below the tick mark
//   threshold — luminance value; pixels with lum >= threshold are treated as walkable
// Lower threshold = more permissive (more pixels treated as walkable).
const FILL_PRESETS = [
  { pos:   0, label: "Ultra loose",  short: "U-Lo",   threshold:  40 },
  { pos:  17, label: "Extra loose",  short: "X-Lo",   threshold:  70 },
  { pos:  33, label: "Loose",        short: "Loose",  threshold: 100 },
  { pos:  50, label: "Balanced",     short: "Bal",    threshold: 160 },
  { pos:  67, label: "Strict",       short: "Strict", threshold: 200 },
  { pos:  83, label: "Extra strict", short: "X-Str",  threshold: 220 },
  { pos: 100, label: "Ultra strict", short: "U-Str",  threshold: 240 },
] as const;

// Map a 0-100 slider value to a luminance dark threshold via piecewise-linear
// interpolation between the preset anchor points.
function sliderToThreshold(v: number): number {
  const clamped = Math.max(0, Math.min(100, v));
  for (let i = 0; i < FILL_PRESETS.length - 1; i++) {
    const a = FILL_PRESETS[i];
    const b = FILL_PRESETS[i + 1];
    if (clamped <= b.pos) {
      const t = (clamped - a.pos) / (b.pos - a.pos);
      return Math.round(a.threshold + t * (b.threshold - a.threshold));
    }
  }
  return FILL_PRESETS[FILL_PRESETS.length - 1].threshold;
}
const MIN_ZONE_PX = 8; // minimum zone size in screen pixels before it's discarded
const API_BASE = `${window.location.origin}/api`;
const INITIAL_SCALE = 0.18; // start zoomed out to show whole floor plan

// Zone-layer alignment calibration increments. Translate is in SVG viewBox
// units (the floor plan viewBox is ~3600×2460, so a few units is a fine nudge);
// scale is a uniform multiplier clamped to a sane range.
const ALIGN_NUDGE_SMALL = 5;
const ALIGN_NUDGE_LARGE = 50;
const ALIGN_SCALE_SMALL = 0.01;
const ALIGN_SCALE_LARGE = 0.05;
const ALIGN_SCALE_MIN = 0.1;
const ALIGN_SCALE_MAX = 5;
const ALIGN_TRANSLATE_MAX = 10000;
const IDENTITY_ALIGN = { x: 0, y: 0, s: 1 };

// ── Types ─────────────────────────────────────────────────────────────────────
interface Zone {
  id: number;
  aisleId: string;
  sectionNum: number | null;
  isInventory: boolean;
  svgX: number;
  svgY: number;
  svgWidth: number;
  svgHeight: number;
  sortOrder: number;
}

interface Tf { x: number; y: number; s: number }
interface Pt { x: number; y: number }
type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
type Mode = "pan" | "draw" | "fill" | "calibrate";

// ── Undo / Redo types ──────────────────────────────────────────────────────
const UNDO_LIMIT = 50;
type PositionSnap = { svgX: number; svgY: number };
type GeomSnap    = { svgX: number; svgY: number; svgWidth: number; svgHeight: number };
type MetaSnap    = Partial<Pick<Zone, "aisleId" | "sectionNum" | "isInventory" | "sortOrder">>;

type UndoEntry =
  | { type: "move";       id: number; before: PositionSnap; after: PositionSnap }
  | { type: "resize";     id: number; before: GeomSnap;     after: GeomSnap }
  | { type: "batchMove";  moves: Array<{ id: number; before: PositionSnap; after: PositionSnap }> }
  | { type: "create";     zones: Zone[] }   // undo = delete; redo = re-POST (ids updated in-place)
  | { type: "delete";     zones: Zone[] }   // undo = re-POST; redo = delete (ids updated in-place)
  | { type: "edit";       id: number; before: MetaSnap; after: MetaSnap }
  | { type: "multiEdit";  changes: Array<{ id: number; before: MetaSnap; after: MetaSnap }> };

export interface FormState {
  aisleId: string;
  sectionNum: number | null;
  isInventory: boolean;
  sortOrder: number;
}

// Interaction state — stored in a ref to avoid stale closures in event handlers
type IxState =
  | { t: "idle" }
  | { t: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { t: "draw"; x1: number; y1: number; x2: number; y2: number }
  | { t: "move"; id: number; ox: number; oy: number }
  | { t: "resize"; id: number; handle: Handle; ax: number; ay: number }
  | { t: "rubber"; x1: number; y1: number; x2: number; y2: number; shift: boolean }
  | { t: "multiMove"; startX: number; startY: number }
  // Fill: waits for mouseup with < 5 px movement before triggering the async fill.
  | { t: "fillPending"; sx: number; sy: number }
  // Calibrate: drag the whole zone layer. ax/ay = align translate at drag start.
  | { t: "alignPan"; sx: number; sy: number; ax: number; ay: number };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a sectionNum to a display string.
 * Null (unassigned) returns an empty string.
 * Non-negative numbers display as zero-padded two-digit strings ("00", "06", "14" …).
 * Negative sentinels (legacy) display as capital letters:
 *   -1 → "A", -2 → "B", … -26 → "Z", -27 → "AA", -28 → "AB" …
 */
function sectionNumToDisplay(n: number | null): string {
  if (n === null) return "";
  if (n >= 0) return String(n).padStart(2, "0");
  let val = -n;
  let result = "";
  while (val > 0) {
    val--;
    result = String.fromCharCode(65 + (val % 26)) + result;
    val = Math.floor(val / 26);
  }
  return result;
}

/**
 * Formats a raw aisle-ID or section string for two-digit display.
 * Pure single-digit numbers are zero-padded ("1" → "01", "9" → "09").
 * Multi-digit numbers and letter codes are returned uppercased as-is.
 * Empty/whitespace strings are returned unchanged.
 */
function formatTwoDigit(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!t) return t;
  if (/^\d$/.test(t)) return "0" + t;
  return t;
}

/**
 * Parses a section number input string.
 * A letter string (A–Z, AA–ZZ …) maps to the corresponding negative sentinel.
 * A numeric string is parsed as a plain integer.
 * Returns null for empty or unparseable input.
 */
function parseSectionInput(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  if (/^[A-Za-z]+$/.test(s)) {
    const upper = s.toUpperCase();
    let val = 0;
    for (let i = 0; i < upper.length; i++) {
      val = val * 26 + (upper.charCodeAt(i) - 64);
    }
    return -val;
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

/**
 * Returns the next available unassigned sentinel (a negative integer) for the
 * given aisle.  Existing sentinels in that aisle are found and the next one
 * below the minimum is returned.  The first unassigned zone in any aisle gets
 * -1 (displayed as "A"), the second -2 ("B"), and so on.
 */
function nextSentinelForAisle(zones: ZoneLike[], aisleId: string): number {
  const normalized = normalizeAisleId(aisleId);
  const sentinels = zones
    .filter((z) => normalizeAisleId(z.aisleId) === normalized && z.sectionNum !== null && z.sectionNum < 0)
    .map((z) => z.sectionNum as number);
  return sentinels.length === 0 ? -1 : Math.min(...sentinels) - 1;
}

/**
 * Builds per-zone PATCH payloads for a bulk aisle-ID update, resolving
 * (aisleId, sectionNum) unique-constraint conflicts before any request fires.
 *
 * When zones from different source aisles share the same sectionNum value,
 * moving them all to the same target aisle would create duplicate
 * (newAisleId, sectionNum) pairs, which PostgreSQL rejects. This function
 * detects those collisions and auto-assigns new negative sentinel sectionNums
 * (displayed as "A", "B", …) to conflicting zones so every PATCH succeeds.
 *
 * Conflict resolution only activates when `updates.aisleId` is set AND
 * `updates.sectionNum` is NOT set (i.e. the user is only reassigning the
 * aisle, not explicitly overriding section numbers). When the user provides
 * an explicit sectionNum the payloads are returned unchanged — same as before.
 */
export function buildBulkAislePatchJobs(
  ids: number[],
  allZones: Zone[],
  updates: Partial<Zone>,
): Array<{ id: number; body: Partial<Zone>; before: MetaSnap; after: MetaSnap }> {
  const targetAisleId = updates.aisleId;

  if (!targetAisleId || updates.sectionNum !== undefined) {
    // No aisleId change, or sectionNum explicitly set — use a uniform body for all.
    return ids.map((id) => {
      const zone = allZones.find((z) => z.id === id);
      const before: MetaSnap = {};
      if (updates.aisleId !== undefined) before.aisleId = zone?.aisleId;
      if (updates.sectionNum !== undefined) before.sectionNum = zone?.sectionNum;
      return { id, body: updates, before, after: updates as MetaSnap };
    });
  }

  const normalizedTarget = normalizeAisleId(targetAisleId);
  const selectedSet = new Set(ids);

  // sectionNums already in use in the target aisle by NON-selected zones.
  // We build this set as a "taken" pool and add to it as we resolve each zone
  // in the batch so intra-batch conflicts are also caught.
  // NULL sectionNums are excluded — multiple zones may share NULL simultaneously.
  const taken = new Set<number>(
    allZones
      .filter((z) => normalizeAisleId(z.aisleId) === normalizedTarget && !selectedSet.has(z.id) && z.sectionNum !== null)
      .map((z) => z.sectionNum as number),
  );

  // Start allocating sentinels just below the lowest negative already in the
  // target aisle (so we never collide with existing assigned sentinels there).
  const existingTargetNegatives = allZones
    .filter((z) => normalizeAisleId(z.aisleId) === normalizedTarget && z.sectionNum !== null && z.sectionNum < 0)
    .map((z) => z.sectionNum as number);
  let nextSentinel = (existingTargetNegatives.length > 0 ? Math.min(...existingTargetNegatives) : 0) - 1;

  return ids.map((id) => {
    const zone = allZones.find((z) => z.id === id);
    const existingSectionNum = zone?.sectionNum ?? null;
    const before: MetaSnap = {
      aisleId: zone?.aisleId,
      sectionNum: existingSectionNum,
    };

    let resolvedSectionNum: number | null;
    let body: Partial<Zone>;
    let after: MetaSnap;

    if (existingSectionNum !== null && taken.has(existingSectionNum)) {
      // Conflict — allocate the next available sentinel not yet claimed.
      while (taken.has(nextSentinel)) nextSentinel--;
      resolvedSectionNum = nextSentinel--;
      body = { aisleId: normalizedTarget, sectionNum: resolvedSectionNum };
      after = { aisleId: normalizedTarget, sectionNum: resolvedSectionNum };
    } else {
      // No conflict — keep the zone's current sectionNum unchanged.
      // The PATCH body omits sectionNum (unchanged), so `after` must also omit
      // it so the redo PATCH matches the original PATCH exactly.
      resolvedSectionNum = existingSectionNum;
      body = { aisleId: normalizedTarget };
      after = { aisleId: normalizedTarget };
    }

    // Mark this sectionNum as taken so subsequent zones in the batch don't reuse it.
    if (resolvedSectionNum !== null) taken.add(resolvedSectionNum);

    return { id, body, before, after };
  });
}

/**
 * Computes the ordered auto-number preview for a set of selected zones.
 * Zones are sorted by sortOrder first, then by svgY (vertical position).
 * Each zone is assigned a sequential sectionNum starting at `start` and
 * incrementing by `increment` (clamped to a minimum of 1).
 */
export function buildAutoNumPreview(
  zones: Zone[],
  selectedIds: Set<number>,
  start: number,
  increment: number,
  digits: number,
  orderedIds?: number[],
): Array<{ zone: Zone; newSectionNum: number; newSectionNumDisplay: string; newSortOrder: number }> {
  if (selectedIds.size === 0) return [];
  const selected = zones.filter((z) => selectedIds.has(z.id));
  let ordered: Zone[];
  if (orderedIds && orderedIds.length > 0) {
    const byId = new Map(selected.map((z) => [z.id, z]));
    ordered = orderedIds.flatMap((id) => {
      const z = byId.get(id);
      return z ? [z] : [];
    });
  } else {
    ordered = [...selected].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.svgY - b.svgY;
    });
  }
  const inc = Math.max(1, increment);
  return ordered.map((zone, i) => {
    const num = start + i * inc;
    const display = digits > 1 ? String(num).padStart(digits, "0") : String(num);
    return { zone, newSectionNum: num, newSectionNumDisplay: display, newSortOrder: num };
  });
}

/**
 * Builds the two-phase sentinel map used by handleAutoNumber to safely apply
 * auto-numbering without triggering (aisleId, sectionNum) unique-constraint
 * violations when the new numbers overlap the zones' current numbers.
 *
 * Returns an array of { id, sentinel, newSectionNum } tuples.
 * The caller must:
 *   Phase 1 — PATCH each zone to its `sentinel` value (temporary negative int).
 *   Phase 2 — PATCH each zone from its sentinel to its final `newSectionNum`.
 *
 * Sentinels are negative integers allocated starting just below the lowest
 * negative sectionNum already present in the affected aisles.
 */
export function buildAutoNumSentinelMap(
  preview: Array<{ zone: Zone; newSectionNum: number }>,
  allZones: Zone[],
): Array<{ id: number; sentinel: number; newSectionNum: number }> {
  const affectedAisleIds = new Set(
    preview.map(({ zone }) => normalizeAisleId(zone.aisleId)),
  );
  const existingNegatives = allZones
    .filter((z) => affectedAisleIds.has(normalizeAisleId(z.aisleId)) && z.sectionNum !== null && z.sectionNum < 0)
    .map((z) => z.sectionNum as number);
  let nextSentinel =
    (existingNegatives.length > 0 ? Math.min(...existingNegatives) : 0) - 1;
  return preview.map(({ zone, newSectionNum }) => ({
    id: zone.id,
    sentinel: nextSentinel--,
    newSectionNum,
  }));
}

/**
 * Pre-flight collision check for auto-numbering.
 *
 * Returns the list of (aisleId, sectionNum) pairs where a non-selected zone
 * already holds a sectionNum that a selected zone is about to be assigned.
 * The DB's (aisleId, sectionNum) unique index would reject those Phase-2 PATCHes
 * even after the sentinel dance, because the non-selected zone never moved.
 *
 * If any collisions are returned the caller should abort before Phase 1 starts.
 */
export function buildAutoNumCollisions(
  preview: Array<{ zone: Zone; newSectionNum: number }>,
  allZones: Zone[],
  selectedIds: Set<number>,
): Array<{ aisleId: string; sectionNum: number; conflictingZoneId: number; blockingSectionNum: number }> {
  // Build a lookup: normalized-aisleId + sectionNum → {id, sectionNum}, for every non-selected zone.
  // Zones with null sectionNum are excluded — null values never conflict.
  const nonSelectedKey = new Map<string, { id: number; sectionNum: number }>();
  for (const z of allZones) {
    if (!selectedIds.has(z.id) && z.sectionNum !== null) {
      nonSelectedKey.set(`${normalizeAisleId(z.aisleId)}:${z.sectionNum}`, { id: z.id, sectionNum: z.sectionNum });
    }
  }
  const collisions: Array<{ aisleId: string; sectionNum: number; conflictingZoneId: number; blockingSectionNum: number }> = [];
  for (const { zone, newSectionNum } of preview) {
    const aisleId = normalizeAisleId(zone.aisleId);
    const blocking = nonSelectedKey.get(`${aisleId}:${newSectionNum}`);
    if (blocking !== undefined) {
      collisions.push({ aisleId, sectionNum: newSectionNum, conflictingZoneId: blocking.id, blockingSectionNum: blocking.sectionNum });
    }
  }
  return collisions;
}

// normRect is imported from rubberBandSelect.ts as normRectUtil.

const ANCHOR: Record<Handle, (z: Zone) => Pt> = {
  nw: (z) => ({ x: z.svgX + z.svgWidth, y: z.svgY + z.svgHeight }),
  ne: (z) => ({ x: z.svgX, y: z.svgY + z.svgHeight }),
  sw: (z) => ({ x: z.svgX + z.svgWidth, y: z.svgY }),
  se: (z) => ({ x: z.svgX, y: z.svgY }),
  // Edge handles — ax/ay unused for edge resize; set to zone center as placeholder
  n:  (z) => ({ x: z.svgX + z.svgWidth / 2, y: z.svgY + z.svgHeight }),
  s:  (z) => ({ x: z.svgX + z.svgWidth / 2, y: z.svgY }),
  e:  (z) => ({ x: z.svgX, y: z.svgY + z.svgHeight / 2 }),
  w:  (z) => ({ x: z.svgX + z.svgWidth, y: z.svgY + z.svgHeight / 2 }),
};

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n:  "ns-resize",
  s:  "ns-resize",
  e:  "ew-resize",
  w:  "ew-resize",
};

// ── Crash-recovery draft helpers (localStorage, keyed by zone ID) ─────────────
// Persists unsaved form edits when the PATCH fails (e.g. server unreachable).
// On next zone selection the editor compares the draft against the server state
// and offers to restore if they differ.
const DRAFT_LS_PREFIX = "zoneEditorDraft:";
function draftKey(id: number) { return `${DRAFT_LS_PREFIX}${id}`; }
function writeDraft(id: number, f: FormState) {
  try { localStorage.setItem(draftKey(id), JSON.stringify({ form: f, savedAt: Date.now() })); } catch {}
}
function clearDraft(id: number) {
  try { localStorage.removeItem(draftKey(id)); } catch {}
}
function readDraft(id: number): { form: FormState; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as { form: FormState; savedAt: number };
  } catch { return null; }
}

// ── Undo / Redo singletons (module-level so they survive panel navigation) ────
// These intentionally live outside React: they persist as long as the JS module
// is loaded (i.e. the whole browser tab session) and are wiped on full reload.
const undoStackRef: { current: UndoEntry[] } = { current: [] };
const redoStackRef: { current: UndoEntry[] } = { current: [] };

// ── Main Component ────────────────────────────────────────────────────────────
export function ZoneEditor() {
  // Admin auth is handled by <AdminGate> in App.tsx (Clerk session). This
  // component assumes it only renders for a signed-in admin, and relies on the
  // Clerk session cookie being sent automatically with same-origin API requests.
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Floor plan SVG: starts with bundled fallback, then replaced by latest upload.
  const [svgInner, setSvgInner] = useState<string>(svgFallbackInner);
  // Natural coordinate dimensions of the floor plan SVG (for rasterizer mapping).
  const [svgDims, setSvgDims] = useState<{ w: number; h: number }>(svgFallbackDims);
  const [tf, setTf] = useState<Tf>({ x: 0, y: 0, s: INITIAL_SCALE });
  const [mode, setMode] = useState<Mode>("pan");
  // ── Global zone-layer alignment calibration ───────────────────────────────
  // `align` is the working offset shown live in calibrate mode; `savedAlign` is
  // the last value persisted to the server (used to detect unsaved changes).
  // translate x/y are in SVG viewBox units; s is a uniform scale about origin.
  const [align, setAlign] = useState<{ x: number; y: number; s: number }>(IDENTITY_ALIGN);
  const [savedAlign, setSavedAlign] = useState<{ x: number; y: number; s: number }>(IDENTITY_ALIGN);
  const [savingAlign, setSavingAlign] = useState(false);
  // True while the async rasterize+fill operation is in progress.
  const [fillLoading, setFillLoading] = useState(false);
  // Fill sensitivity: slider position 0-100, persisted to localStorage.
  const [fillSensitivity, setFillSensitivity] = useState<number>(() => {
    try {
      const stored = localStorage.getItem("zoneEditorFillSensitivity");
      if (stored !== null) {
        const n = Number(stored);
        if (!isNaN(n) && n >= 0 && n <= 100) return Math.round(n);
        // Legacy: named keys from before the slider was introduced
        const legacy: Record<string, number> = {
          ultraLoose: 0, extraLoose: 17, low: 33, medium: 50,
          high: 67, extraStrict: 83, ultraStrict: 100,
        };
        if (stored in legacy) return legacy[stored]!;
      }
    } catch {}
    return 67; // default: Strict (was "high")
  });

  // Multi-select: a Set of selected zone IDs
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Selection order: zone IDs in the order they were added to the selection.
  // Used by Auto-Number to assign numbers in tap/click sequence.
  const [selectionOrder, setSelectionOrder] = useState<number[]>([]);

  // draftRect: the live rectangle being drawn (while dragging in draw mode)
  const [draftRect, setDraftRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);
  // fillFlashRect: 300 ms visual feedback flash shown after a fill click (blue)
  const [fillFlashRect, setFillFlashRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);
  // pendingRect: drawn but not yet saved (shows in sidebar form)
  const [pendingRect, setPendingRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);
  // dragZone: live zone position during move/resize (single-select)
  const [dragZone, setDragZone] = useState<Zone | null>(null);
  // multiDragDelta: live offset applied to all selected zones during multi-move
  const [multiDragDelta, setMultiDragDelta] = useState<Pt | null>(null);
  // Original positions of every selected zone at the start of a multi-move drag
  const multiDragOriginsRef = useRef<Map<number, Pt>>(new Map());
  const [form, setFormState] = useState<FormState>({
    aisleId: "", sectionNum: null, isInventory: true, sortOrder: 0,
  });
  const formRef = useRef<FormState>({ aisleId: "", sectionNum: null, isInventory: true, sortOrder: 0 });
  const setForm = useCallback((f: FormState) => { formRef.current = f; setFormState(f); }, []);
  const [saving, setSaving] = useState(false);

  // Crash-recovery draft offer: set when the selected zone has a localStorage
  // draft that differs from the current server state.
  const [draftOffer, setDraftOffer] = useState<{
    zoneId: number;
    form: FormState;
    savedAt: number;
  } | null>(null);

  // Multi-select form fields
  const [multiAisleId, setMultiAisleId] = useState("");
  const [multiSectionNum, setMultiSectionNum] = useState("");
  const [multiSaving, setMultiSaving] = useState(false);
  // Track last-saved values so blur auto-save can diff against them
  const lastMultiAisleIdRef = useRef("");
  const lastMultiSectionNumRef = useRef("");
  const [coverage, setCoverage] = useState<{
    unsortedCount: number;
    uncoveredAisles: string[];
  } | null>(null);

  // ── Auto-number panel state ────────────────────────────────────────────────
  const [autoNumOpen, setAutoNumOpen] = useState(false);
  const [autoNumStartMode, setAutoNumStartMode] = useState<"0" | "1" | "2" | "custom">(() => {
    try {
      const stored = localStorage.getItem("zoneEditorAutoNumStartMode");
      if (stored === "0" || stored === "1" || stored === "2" || stored === "custom") return stored;
    } catch {}
    return "1";
  });
  const [autoNumStartCustom, setAutoNumStartCustom] = useState<string>(() => {
    try { return localStorage.getItem("zoneEditorAutoNumStartCustom") ?? ""; } catch {}
    return "";
  });
  const autoNumStart =
    autoNumStartMode === "custom"
      ? (() => { const p = parseInt(autoNumStartCustom, 10); return isNaN(p) ? 1 : Math.max(0, p); })()
      : Number(autoNumStartMode);
  const autoNumDigits =
    autoNumStartMode === "0"
      ? 2
      : autoNumStartMode === "custom" && autoNumStartCustom.length > 1
      ? autoNumStartCustom.length
      : 1;
  const [autoNumIncrement, setAutoNumIncrement] = useState<number>(() => {
    try {
      const stored = localStorage.getItem("zoneEditorAutoNumIncrement");
      if (stored !== null) { const n = Number(stored); if (Number.isInteger(n) && n >= 1) return n; }
    } catch {}
    return 2;
  });
  const [autoNumSyncSortOrder, setAutoNumSyncSortOrder] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("zoneEditorAutoNumSyncSortOrder");
      if (stored !== null) return stored === "true";
    } catch {}
    return true;
  });
  const [autoNumApplying, setAutoNumApplying] = useState(false);
  const [zoneEditOpen, setZoneEditOpen] = useState(true);
  const [zoneListOpen, setZoneListOpen] = useState(true);

  // Branded confirm dialog (replaces window.confirm)
  const [confirmState, setConfirmState] = useState<{
    visible: boolean;
    title: string;
    message: string;
    destructive: boolean;
    resolve: ((ok: boolean) => void) | null;
  }>({ visible: false, title: "", message: "", destructive: false, resolve: null });

  const showConfirm = (title: string, message: string, destructive = false): Promise<boolean> =>
    new Promise((resolve) =>
      setConfirmState({ visible: true, title, message, destructive, resolve })
    );

  const handleConfirmResponse = (ok: boolean) => {
    setConfirmState((prev) => {
      prev.resolve?.(ok);
      return { visible: false, title: "", message: "", destructive: false, resolve: null };
    });
  };

  // Refs — updated every render so event handlers never go stale
  const svgRef = useRef<SVGSVGElement>(null);
  const floorPlanRef = useRef<SVGGElement>(null);
  const ixRef = useRef<IxState>({ t: "idle" });
  const tfRef = useRef(tf);
  const zonesRef = useRef(zones);
  const dragZoneRef = useRef<Zone | null>(null);
  const modeRef = useRef(mode);
  const selectedIdsRef = useRef(selectedIds);
  const svgInnerRef = useRef(svgInner);
  const svgDimsRef = useRef(svgDims);
  const fillLoadingRef = useRef(false);
  const fillSensitivityRef = useRef(fillSensitivity);
  const alignRef = useRef(align);

  // Mutex: prevents concurrent undo/redo from corrupting the stack when the
  // user holds Cmd+Z or fires repeated keypresses during an async operation.
  const undoRedoBusyRef = useRef(false);
  // Reactive counts — mirrors the ref lengths so toolbar buttons re-render.
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  useEffect(() => { tfRef.current = tf; }, [tf]);
  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { dragZoneRef.current = dragZone; }, [dragZone]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { svgInnerRef.current = svgInner; }, [svgInner]);
  useEffect(() => { svgDimsRef.current = svgDims; }, [svgDims]);
  useEffect(() => { fillLoadingRef.current = fillLoading; }, [fillLoading]);
  useEffect(() => { alignRef.current = align; }, [align]);
  useEffect(() => {
    fillSensitivityRef.current = fillSensitivity;
    try { localStorage.setItem("zoneEditorFillSensitivity", String(fillSensitivity)); } catch {}
  }, [fillSensitivity]);
  useEffect(() => {
    try { localStorage.setItem("zoneEditorAutoNumStartMode", autoNumStartMode); } catch {}
  }, [autoNumStartMode]);
  useEffect(() => {
    try { localStorage.setItem("zoneEditorAutoNumStartCustom", autoNumStartCustom); } catch {}
  }, [autoNumStartCustom]);
  useEffect(() => {
    try { localStorage.setItem("zoneEditorAutoNumIncrement", String(autoNumIncrement)); } catch {}
  }, [autoNumIncrement]);
  useEffect(() => {
    try { localStorage.setItem("zoneEditorAutoNumSyncSortOrder", String(autoNumSyncSortOrder)); } catch {}
  }, [autoNumSyncSortOrder]);


  // Fetch the latest uploaded floor plan. Tries the local API first; if it
  // returns 404 (nothing uploaded in this env), falls back to the production
  // API defined by VITE_FLOOR_PLAN_API_FALLBACK. The bundled SVG is only
  // shown when both attempts fail or the env has no fallback configured.
  useEffect(() => {
    void (async () => {
      const fallback = (import.meta.env.VITE_FLOOR_PLAN_API_FALLBACK as string | undefined)?.replace(/\/$/, "");
      const urls = [`${API_BASE}/floor-plan/svg`];
      if (fallback && fallback !== API_BASE) urls.push(`${fallback}/floor-plan/svg`);
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const raw = await res.text();
            setSvgInner(extractSvgInner(raw));
            setSvgDims(extractSvgDims(raw));
            // Invalidate the raster cache whenever the floor plan changes.
            _rasterCache = null;
            return;
          }
        } catch {}
      }
    })();
  }, []);

  // Inject the floor plan SVG directly into the SVG DOM so it shares the same
  // coordinate system as the zone overlays and stays crisp at any zoom level.
  useEffect(() => {
    if (floorPlanRef.current) {
      floorPlanRef.current.innerHTML = svgInner;
    }
  }, [svgInner]);

  // ── Derived selection values ──────────────────────────────────────────────
  // selectedId is non-null only when exactly one zone is selected
  const selectedId: number | null = selectedIds.size === 1 ? [...selectedIds][0]! : null;
  const isMulti = selectedIds.size > 1;
  const selectedZone = useMemo(
    () => zones.find((z) => z.id === selectedId) ?? null,
    [zones, selectedId],
  );
  const selectedZoneList = useMemo(
    () => zones.filter((z) => selectedIds.has(z.id)),
    [zones, selectedIds],
  );

  // Inline validation for the Aisle ID field (only when a value is present;
  // empty string is handled at save-time as "required").
  const aisleIdError: string | null = useMemo(() => {
    if (!form.aisleId.trim()) return null;
    return isValidAisleId(form.aisleId) ? null : "Aisle ID must be a number (e.g. 09)";
  }, [form.aisleId]);

  // Tracks the form values as they were when last loaded from the server (used to
  // suppress false conflict warnings when a zone is selected but not yet changed).
  const lastSavedFormRef = useRef<FormState | null>(null);
  const prevSelectedIdRef = useRef<number | null>(null);
  const zoneFormRef = useRef<ZoneFormHandle>(null);
  // Tracks the selectedIds set from the previous render while in multi-select
  // so the selection-change flush effect can target the zones being edited, not
  // the newly selected zone(s).
  const prevMultiSelectedIdsRef = useRef<ReadonlySet<number>>(new Set());

  // Non-blocking duplicate warning: another zone already claims this aisle+parity.
  const duplicateConflict = useMemo(() => {
    if (!form.aisleId.trim() || !isValidAisleId(form.aisleId)) return null;
    // Suppress the warning when editing an existing zone whose aisle ID and
    // parity haven't changed from the last-saved state — the conflict already
    // existed in the database and saving the untouched form won't create a
    // new overlap.
    if (
      selectedId !== null &&
      normalizeAisleId(form.aisleId) ===
        normalizeAisleId(lastSavedFormRef.current?.aisleId ?? "") &&
      form.sectionNum === lastSavedFormRef.current?.sectionNum
    ) {
      return null;
    }
    return findDuplicateConflict(zones, selectedId, form.aisleId, form.sectionNum);
  }, [zones, form.aisleId, form.sectionNum, selectedId]);

  // ── Undo / Redo helpers ──────────────────────────────────────────────────
  const pushUndo = useCallback((entry: UndoEntry) => {
    const stack = undoStackRef.current;
    const last = stack.length > 0 ? stack[stack.length - 1] : undefined;
    // Merge consecutive "edit" entries for the same zone: if the new entry's
    // `before` state equals the previous entry's `after` state, the two entries
    // form a contiguous chain (no other save happened in between).  Collapsing
    // them keeps the undo stack manageable when the user types quickly and the
    // 600 ms auto-save fires many times before they click away.
    if (
      entry.type === "edit" &&
      last?.type === "edit" &&
      last.id === entry.id &&
      JSON.stringify(last.after) === JSON.stringify(entry.before)
    ) {
      const merged: UndoEntry = { type: "edit", id: entry.id, before: last.before, after: entry.after };
      undoStackRef.current = [...stack.slice(0, -1), merged];
    } else {
      undoStackRef.current = [...stack.slice(-(UNDO_LIMIT - 1)), entry];
    }
    redoStackRef.current = [];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(0);
  }, []);

  // ── API helpers ─────────────────────────────────────────────────────────────
  // The Clerk session cookie is sent automatically with same-origin requests, so
  // no Authorization header is needed here.
  const headers = useCallback(
    (): Record<string, string> => ({
      "Content-Type": "application/json",
    }),
    [],
  );

  const fetchZones = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`${API_BASE}/warehouse-zones`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setZones(data.zones ?? []);
      setDragZone(null);
      // Also refresh coverage stats (non-critical — suppress errors)
      void fetch(`${API_BASE}/warehouse-zones/coverage`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { unsortedCount: number; uncoveredAisles: string[] } | null) => {
          if (d) setCoverage(d);
        })
        .catch(() => {});
    } catch {
      setLoadError("Failed to load zones — is the API server running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchZones(); }, [fetchZones]);

  // Load the saved global zone-layer alignment on mount so calibrate mode opens
  // with the current live offset (and the map preview matches production).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/warehouse-zones/alignment`);
        if (!res.ok) return;
        const d = await res.json();
        if (cancelled) return;
        const next = {
          x: Number.isFinite(d?.translateX) ? d.translateX : 0,
          y: Number.isFinite(d?.translateY) ? d.translateY : 0,
          s: Number.isFinite(d?.scale) && d.scale > 0 ? d.scale : 1,
        };
        setAlign(next);
        setSavedAlign(next);
      } catch { /* leave identity offset in place */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist the working alignment offset globally (admin-only PUT).
  const saveAlignment = useCallback(async () => {
    setSavingAlign(true);
    try {
      const res = await fetch(`${API_BASE}/warehouse-zones/alignment`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ translateX: align.x, translateY: align.y, scale: align.s }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedAlign({ ...align });
      toast.success("Alignment saved for all users");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAlign(false);
    }
  }, [align, headers]);

  // Nudge the working offset by a translate delta (SVG viewBox units), clamped to ±ALIGN_TRANSLATE_MAX.
  const nudgeAlign = useCallback((dx: number, dy: number) => {
    setAlign((prev) => ({
      ...prev,
      x: Math.min(ALIGN_TRANSLATE_MAX, Math.max(-ALIGN_TRANSLATE_MAX, prev.x + dx)),
      y: Math.min(ALIGN_TRANSLATE_MAX, Math.max(-ALIGN_TRANSLATE_MAX, prev.y + dy)),
    }));
  }, []);

  // Adjust the working uniform scale, clamped to a sane range.
  const scaleAlign = useCallback((delta: number) => {
    setAlign((prev) => ({
      ...prev,
      s: Math.min(ALIGN_SCALE_MAX, Math.max(ALIGN_SCALE_MIN, +(prev.s + delta).toFixed(4))),
    }));
  }, []);

  // ── Keyboard undo / redo shortcuts (Cmd+Z / Ctrl+Z, Cmd+Shift+Z / Ctrl+Shift+Z) ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) return;
      e.preventDefault();
      void applyUndoRedoRef.current?.(e.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Keyboard delete shortcut ─────────────────────────────────────────────
  // Delete or Backspace removes all selected zones, unless focus is in a text field.
  // A confirmation dialog (same as the sidebar Delete button) is shown first.
  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) return;
      const ids = [...selectedIdsRef.current];
      if (ids.length === 0) return;
      e.preventDefault();
      const ok = await showConfirm(
        ids.length === 1 ? "Delete zone" : `Delete ${ids.length} zones`,
        ids.length === 1
          ? "Delete this zone? You can undo with Cmd+Z / Ctrl+Z."
          : `Delete ${ids.length} zones? You can undo with Cmd+Z / Ctrl+Z.`,
        true,
      );
      if (!ok) return;
      const zonesToDelete = zonesRef.current.filter((z) => ids.includes(z.id));
      setSaving(true);
      try {
        await Promise.all(
          ids.map((id) =>
            fetch(`${API_BASE}/warehouse-zones/${id}`, {
              method: "DELETE",
              headers: headers(),
            }).then((res) => {
              if (res.status === 401) { throw new Error("Session expired — please sign in again"); }
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
            }),
          ),
        );
        toast.success(
          ids.length === 1 ? "Zone deleted" : `${ids.length} zones deleted`,
        );
        if (zonesToDelete.length > 0) pushUndo({ type: "delete", zones: zonesToDelete });
        setSelectedIds(new Set());
        setSelectionOrder([]);
        await fetchZones();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fetchZones, pushUndo, headers]);

  // ── Keyboard Escape shortcut — clear active selection ────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectedIdsRef.current.size === 0) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) return;
      e.preventDefault();
      setSelectedIds(new Set());
      setSelectionOrder([]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const patchZone = useCallback(
    async (id: number, updates: Partial<Zone>): Promise<boolean> => {
      const res = await fetch(`${API_BASE}/warehouse-zones/${id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify(updates),
      });
      if (res.status === 401) { throw new Error("Session expired — please sign in again"); }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return true;
    },
    [headers],
  );

  // ── Apply an undo or redo entry against the server ───────────────────────
  // Uses a ref so the keyboard handler below never captures a stale closure.
  const applyUndoRedoRef = useRef<((dir: "undo" | "redo") => Promise<void>) | null>(null);

  const applyUndoRedo = useCallback(async (dir: "undo" | "redo") => {
    if (undoRedoBusyRef.current) return; // drop concurrent key repeats
    undoRedoBusyRef.current = true;
    const srcStack = dir === "undo" ? undoStackRef.current : redoStackRef.current;
    if (srcStack.length === 0) { undoRedoBusyRef.current = false; return; }
    const entry = srcStack[srcStack.length - 1]!;
    const fwd = dir === "redo";
    try {
      switch (entry.type) {
        case "move":
          await patchZone(entry.id, fwd ? entry.after : entry.before);
          toast.success(fwd ? "Redo: position applied" : "Undo: position restored");
          break;
        case "resize":
          await patchZone(entry.id, fwd ? entry.after : entry.before);
          toast.success(fwd ? "Redo: size applied" : "Undo: size restored");
          break;
        case "batchMove":
          await Promise.all(entry.moves.map((m) => patchZone(m.id, fwd ? m.after : m.before)));
          toast.success(fwd ? "Redo: positions applied" : "Undo: positions restored");
          break;
        case "create": {
          if (!fwd) {
            // Undo create → delete the zone(s)
            await Promise.all(entry.zones.map(async (z) => {
              const r = await fetch(`${API_BASE}/warehouse-zones/${z.id}`, { method: "DELETE", headers: headers() });
              if (r.status === 401) { throw new Error("Session expired — please sign in again"); }
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
            }));
            const n = entry.zones.length;
            toast.success(n === 1 ? "Undo: zone removed" : `Undo: ${n} zones removed`);
          } else {
            // Redo create → re-POST; update zone ids in-place for symmetry
            const newZones = await Promise.all(entry.zones.map(async (z) => {
              const r = await fetch(`${API_BASE}/warehouse-zones`, { method: "POST", headers: headers(), body: JSON.stringify({ aisleId: z.aisleId, sectionNum: z.sectionNum, isInventory: z.isInventory, svgX: z.svgX, svgY: z.svgY, svgWidth: z.svgWidth, svgHeight: z.svgHeight, sortOrder: z.sortOrder }) });
              if (r.status === 401) { throw new Error("Session expired — please sign in again"); }
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return ((await r.json()) as { zone: Zone }).zone;
            }));
            entry.zones = newZones;
            const n = newZones.length;
            toast.success(n === 1 ? "Redo: zone recreated" : `Redo: ${n} zones recreated`);
          }
          break;
        }
        case "delete": {
          if (!fwd) {
            // Undo delete → re-POST; update ids in-place for redo symmetry
            const newZones = await Promise.all(entry.zones.map(async (z) => {
              const r = await fetch(`${API_BASE}/warehouse-zones`, { method: "POST", headers: headers(), body: JSON.stringify({ aisleId: z.aisleId, sectionNum: z.sectionNum, isInventory: z.isInventory, svgX: z.svgX, svgY: z.svgY, svgWidth: z.svgWidth, svgHeight: z.svgHeight, sortOrder: z.sortOrder }) });
              if (r.status === 401) { throw new Error("Session expired — please sign in again"); }
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return ((await r.json()) as { zone: Zone }).zone;
            }));
            entry.zones = newZones;
            const n = newZones.length;
            toast.success(n === 1 ? "Undo: zone restored" : `Undo: ${n} zones restored`);
          } else {
            // Redo delete → delete the zone(s)
            await Promise.all(entry.zones.map(async (z) => {
              const r = await fetch(`${API_BASE}/warehouse-zones/${z.id}`, { method: "DELETE", headers: headers() });
              if (r.status === 401) { throw new Error("Session expired — please sign in again"); }
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
            }));
            const n = entry.zones.length;
            toast.success(n === 1 ? "Redo: zone deleted" : `Redo: ${n} zones deleted`);
          }
          break;
        }
        case "edit":
          await patchZone(entry.id, fwd ? entry.after : entry.before);
          toast.success(fwd ? "Redo: edit reapplied" : "Undo: edit reverted");
          break;
        case "multiEdit": {
          // Detect changes that involve sectionNum reassignment without an
          // aisleId change (produced by handleAutoNumber). These can cause
          // (aisleId, sectionNum) unique-constraint collisions during undo/redo
          // when before/after values overlap in the same aisle (e.g. a cyclic
          // swap). Use a two-phase sentinel approach so all current sectionNums
          // are vacated before any target value is written.
          //
          // sortOrder may also be present in the snapshot (when the "sync sort
          // order" checkbox was enabled). It is safe to patch sortOrder in Phase 2
          // alongside the final sectionNum — no unique constraint applies to it.
          const needsSentinel = entry.changes.every(
            (c) =>
              c.before.sectionNum !== undefined &&
              c.before.aisleId === undefined &&
              c.after.sectionNum !== undefined &&
              c.after.aisleId === undefined,
          );

          if (needsSentinel && entry.changes.length > 1) {
            const currentZones = zonesRef.current;
            const affectedIds = new Set(entry.changes.map((c) => c.id));
            const affectedAisles = new Set(
              currentZones
                .filter((z) => affectedIds.has(z.id))
                .map((z) => normalizeAisleId(z.aisleId)),
            );
            const existingNegatives = currentZones
              .filter((z) => affectedAisles.has(normalizeAisleId(z.aisleId)) && z.sectionNum !== null && z.sectionNum < 0)
              .map((z) => z.sectionNum as number);
            let nextSentinel =
              (existingNegatives.length > 0 ? Math.min(...existingNegatives) : 0) - 1;

            const sentinelMap = entry.changes.map((c) => {
              const snap = fwd ? c.after : c.before;
              return {
                id: c.id,
                sentinel: nextSentinel--,
                targetSectionNum: snap.sectionNum!,
                targetSortOrder: snap.sortOrder,
              };
            });

            for (const { id, sentinel } of sentinelMap) {
              await patchZone(id, { sectionNum: sentinel });
            }
            for (const { id, targetSectionNum, targetSortOrder } of sentinelMap) {
              const patch: Partial<Zone> = { sectionNum: targetSectionNum };
              if (targetSortOrder !== undefined) patch.sortOrder = targetSortOrder;
              await patchZone(id, patch);
            }
          } else {
            const results = await Promise.allSettled(
              entry.changes.map((c) => patchZone(c.id, fwd ? c.after : c.before)),
            );
            const failures = results
              .map((r, i) => ({ r, id: entry.changes[i]!.id }))
              .filter(({ r }) => r.status === "rejected");
            if (failures.length > 0) {
              const ids = failures.map(({ id }) => id).join(", ");
              throw new Error(
                `${failures.length} zone${failures.length > 1 ? "s" : ""} failed to update (zone${failures.length > 1 ? "s" : ""} ${ids}); some zones may be in an inconsistent state — please refresh and retry`,
              );
            }
          }
          toast.success(fwd ? "Redo: edits reapplied" : "Undo: edits reverted");
          break;
        }
      }
      // Move the entry between stacks
      if (dir === "undo") {
        undoStackRef.current = undoStackRef.current.slice(0, -1);
        redoStackRef.current = [...redoStackRef.current, entry];
      } else {
        redoStackRef.current = redoStackRef.current.slice(0, -1);
        undoStackRef.current = [...undoStackRef.current, entry];
      }
      setUndoCount(undoStackRef.current.length);
      setRedoCount(redoStackRef.current.length);
      await fetchZones();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      undoRedoBusyRef.current = false;
    }
  }, [patchZone, fetchZones, headers]);

  useEffect(() => { applyUndoRedoRef.current = applyUndoRedo; }, [applyUndoRedo]);

  // ── Form actions ────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!pendingRect) return;
    if (!form.aisleId.trim()) { toast.error("Aisle ID is required"); return; }
    if (!isValidAisleId(form.aisleId)) { toast.error("Aisle ID must be numeric (e.g. 09)"); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/warehouse-zones`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          aisleId: normalizeAisleId(form.aisleId),
          sectionNum: form.sectionNum,
          isInventory: form.isInventory,
          svgX: pendingRect.x,
          svgY: pendingRect.y,
          svgWidth: pendingRect.w,
          svgHeight: pendingRect.h,
          sortOrder: form.sortOrder,
        }),
      });
      if (res.status === 401) { throw new Error("Session expired — please sign in again"); }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { zone } = await res.json() as { zone: Zone };
      toast.success(`Zone for aisle "${zone.aisleId}" created`);
      pushUndo({ type: "create", zones: [zone] });
      setPendingRect(null);
      setSelectedIds(new Set([zone.id]));
      setSelectionOrder([zone.id]);
      setForm({ aisleId: zone.aisleId, sectionNum: zone.sectionNum, isInventory: zone.isInventory, sortOrder: zone.sortOrder });
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Flush unsaved form changes immediately (used by blur-save and selection-change).
  // Takes an explicit FormState so it works even when React state hasn't updated yet.
  //
  // Optimistically sets lastSavedFormRef.current BEFORE the first await so that a
  // concurrent flush for the same zone (onBlur fires, then selection-change effect
  // runs before the PATCH resolves) sees the equality check as true and skips.
  const flushSave = useCallback(async (committedForm: FormState, zoneId: number) => {
    if (!committedForm.aisleId.trim()) return;
    if (!isValidAisleId(committedForm.aisleId)) return;
    if (JSON.stringify(committedForm) === JSON.stringify(lastSavedFormRef.current)) return;
    if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    const beforeMeta: MetaSnap = lastSavedFormRef.current ? { ...lastSavedFormRef.current } : {};
    // Optimistic: mark as saved now so concurrent flush calls skip the duplicate PATCH.
    lastSavedFormRef.current = { ...committedForm };
    const afterMeta: MetaSnap = {
      aisleId: normalizeAisleId(committedForm.aisleId),
      sectionNum: committedForm.sectionNum,
      isInventory: committedForm.isInventory,
      sortOrder: committedForm.sortOrder,
    };
    try {
      await patchZone(zoneId, afterMeta);
      clearDraft(zoneId);
      pushUndo({ type: "edit", id: zoneId, before: beforeMeta, after: afterMeta });
      toast.success("Saved");
      await fetchZones();
    } catch (e) {
      // Persist the unsaved form to localStorage so it can be recovered when
      // the server comes back online and the user re-selects this zone.
      writeDraft(zoneId, committedForm);
      toast.error(e instanceof Error ? e.message : String(e));
      // Do not restore lastSavedFormRef on failure — selection may have already
      // changed, overwriting it with a different zone's baseline.
    }
  }, [patchZone, pushUndo, fetchZones]);

  const handleSaveEdit = async () => {
    if (!selectedId) return;
    // Read committed values — zoneFormRef.current captures rawSection even
    // if React state hasn't flushed the section-number onBlur yet.
    const committedForm = zoneFormRef.current?.getCommittedForm() ?? form;
    if (!committedForm.aisleId.trim()) { toast.error("Aisle ID is required"); return; }
    if (!isValidAisleId(committedForm.aisleId)) { toast.error("Aisle ID must be numeric (e.g. 09)"); return; }
    if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    const beforeMeta: MetaSnap = lastSavedFormRef.current ? { ...lastSavedFormRef.current } : {};
    setSaving(true);
    try {
      const afterMeta: MetaSnap = {
        aisleId: normalizeAisleId(committedForm.aisleId),
        sectionNum: committedForm.sectionNum,
        isInventory: committedForm.isInventory,
        sortOrder: committedForm.sortOrder,
      };
      await patchZone(selectedId, afterMeta);
      clearDraft(selectedId);
      pushUndo({ type: "edit", id: selectedId, before: beforeMeta, after: afterMeta });
      lastSavedFormRef.current = { ...committedForm };
      toast.success("Zone updated");
      await fetchZones();
    } catch (e) {
      writeDraft(selectedId, committedForm);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (!await showConfirm("Delete zone", "Delete this zone? You can undo with Cmd+Z / Ctrl+Z.", true)) return;
    const zoneToDelete = zones.find((z) => z.id === selectedId);
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/warehouse-zones/${selectedId}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (res.status === 401) { throw new Error("Session expired — please sign in again"); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Zone deleted");
      if (zoneToDelete) pushUndo({ type: "delete", zones: [zoneToDelete] });
      setSelectedIds(new Set());
      setSelectionOrder([]);
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    if (!selectedZone) return;
    setSaving(true);
    try {
      const targetAisleId = normalizeAisleId(form.aisleId);
      const res = await fetch(`${API_BASE}/warehouse-zones`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          aisleId: targetAisleId,
          sectionNum: null,
          isInventory: form.isInventory,
          svgX: selectedZone.svgX + selectedZone.svgWidth + 2,
          svgY: selectedZone.svgY,
          svgWidth: selectedZone.svgWidth,
          svgHeight: selectedZone.svgHeight,
          sortOrder: form.sortOrder,
        }),
      });
      if (res.status === 401) { throw new Error("Session expired — please sign in again"); }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { zone } = await res.json() as { zone: Zone };
      toast.success(`Duplicated → placed to the right`);
      pushUndo({ type: "create", zones: [zone] });
      setSelectedIds(new Set([zone.id]));
      setSelectionOrder([zone.id]);
      setForm({ aisleId: zone.aisleId, sectionNum: zone.sectionNum, isInventory: zone.isInventory, sortOrder: zone.sortOrder });
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleMultiDuplicate = async () => {
    if (selectedZoneList.length === 0) return;
    setSaving(true);
    try {
      const sortedSelection = [...selectedZoneList].sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.svgY - b.svgY;
      });
      const results = await Promise.all(
        sortedSelection.map((z) => {
          return fetch(`${API_BASE}/warehouse-zones`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({
              aisleId: z.aisleId,
              sectionNum: null,
              isInventory: z.isInventory,
              sortOrder: z.sortOrder,
              svgX: z.svgX,
              svgY: z.svgY + z.svgHeight + 4,
              svgWidth: z.svgWidth,
              svgHeight: z.svgHeight,
            }),
          }).then(async (res) => {
            if (res.status === 401) { throw new Error("Session expired — please sign in again"); }
            if (!res.ok) {
              const err = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(err.error ?? `HTTP ${res.status}`);
            }
            return res.json() as Promise<{ zone: Zone }>;
          });
        }),
      );
      const newIds = new Set(results.map((r) => r.zone.id));
      toast.success(`Duplicated ${newIds.size} zone${newIds.size !== 1 ? "s" : ""} — drag to reposition`);
      pushUndo({ type: "create", zones: results.map((r) => r.zone) });
      setSelectedIds(newIds);
      setSelectionOrder([...newIds]);
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleResetSectionNumToNull = async () => {
    if (selectedIds.size === 0) return;
    const undoChanges = [...selectedIds].map((id) => {
      const zone = zones.find((z) => z.id === id);
      return {
        id,
        before: { sectionNum: zone?.sectionNum ?? null } as MetaSnap,
        after: { sectionNum: null } as MetaSnap,
      };
    });
    try {
      await Promise.all([...selectedIds].map((id) => patchZone(id, { sectionNum: null })));
      pushUndo({ type: "multiEdit", changes: undoChanges });
      toast.success(`Reset §number for ${selectedIds.size} zone${selectedIds.size !== 1 ? "s" : ""}`);
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleMultiSave = async (updates: Partial<Zone>) => {
    const n = selectedIds.size;
    const parts: string[] = [];
    if (updates.aisleId) parts.push(`Aisle ID → ${updates.aisleId}`);
    if (updates.sectionNum !== undefined) parts.push(`Section # → ${sectionNumToDisplay(updates.sectionNum)}`);
    const what = parts.length ? parts.join(", ") : "selected properties";
    if (!await showConfirm(`Update ${n} zone${n !== 1 ? "s" : ""}`, what)) return;
    // Build per-zone patch bodies, resolving any (aisleId, sectionNum) conflicts
    // that would arise when zones from different source aisles share a sectionNum.
    const jobs = buildBulkAislePatchJobs([...selectedIds], zonesRef.current, updates);
    const undoChanges = jobs.map(({ id, before, after }) => ({ id, before, after }));
    setMultiSaving(true);
    try {
      await Promise.all(jobs.map(({ id, body }) => patchZone(id, body)));
      pushUndo({ type: "multiEdit", changes: undoChanges });
      if (updates.aisleId !== undefined) lastMultiAisleIdRef.current = updates.aisleId;
      if (updates.sectionNum !== undefined) {
        lastMultiSectionNumRef.current = sectionNumToDisplay(updates.sectionNum);
      } else if (jobs.some((j) => j.body.sectionNum !== undefined)) {
        // Some zones were auto-reassigned sentinels — values are now mixed, clear ref
        // so a subsequent blur doesn't spuriously re-apply the old sectionNum.
        lastMultiSectionNumRef.current = "";
      }
      toast.success(`Updated ${n} zones`);
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setMultiSaving(false);
    }
  };

  // Auto-save multi-select aisle data on blur (no confirm dialog)
  // idsOverride lets the selection-change effect pass the *previous* multi-selection
  // so the save targets the zones the user was actually editing, not the new selection.
  const handleMultiAutoSave = async (idsOverride?: ReadonlySet<number>) => {
    const ids = idsOverride ?? selectedIds;
    if (multiSaving || ids.size === 0) return;
    const updates: Partial<Zone> = {};
    const trimmedAisle = multiAisleId.trim();
    if (trimmedAisle && trimmedAisle !== lastMultiAisleIdRef.current) {
      if (!isValidAisleId(trimmedAisle)) return;
      updates.aisleId = normalizeAisleId(trimmedAisle);
    }
    const trimmedSectionNum = multiSectionNum.trim();
    if (trimmedSectionNum && trimmedSectionNum !== lastMultiSectionNumRef.current) {
      const parsed = parseSectionInput(trimmedSectionNum);
      if (parsed !== null) updates.sectionNum = parsed;
    }
    if (Object.keys(updates).length === 0) return;
    // Build per-zone patch bodies, resolving any (aisleId, sectionNum) conflicts.
    const jobs = buildBulkAislePatchJobs([...ids], zonesRef.current, updates);
    const undoChanges = jobs.map(({ id, before, after }) => ({ id, before, after }));
    setMultiSaving(true);
    try {
      await Promise.all(jobs.map(({ id, body }) => patchZone(id, body)));
      pushUndo({ type: "multiEdit", changes: undoChanges });
      if (updates.aisleId !== undefined) lastMultiAisleIdRef.current = updates.aisleId;
      if (updates.sectionNum !== undefined) {
        lastMultiSectionNumRef.current = sectionNumToDisplay(updates.sectionNum);
      } else if (jobs.some((j) => j.body.sectionNum !== undefined)) {
        lastMultiSectionNumRef.current = "";
      }
      const n = ids.size;
      toast.success(`Saved ${n} zone${n !== 1 ? "s" : ""}`);
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setMultiSaving(false);
    }
  };

  // ── Auto-number handler ────────────────────────────────────────────────────
  const handleAutoNumber = async () => {
    if (autoNumPreview.length === 0) return;

    // Pre-flight: catch collisions with non-selected zones BEFORE any DB writes.
    // The two-phase sentinel strategy only parks selected zones, so a non-selected
    // zone that already holds a target sectionNum would still cause a unique-index
    // violation in Phase 2.
    const collisions = buildAutoNumCollisions(autoNumPreview, zones, selectedIds);
    if (collisions.length > 0) {
      const { aisleId, sectionNum, blockingSectionNum } = collisions[0]!;
      toast.error(
        `Section ${sectionNum} in Aisle ${aisleId} is taken by the zone currently at §${blockingSectionNum} — select it too or pick a different starting number.`,
      );
      return;
    }

    // Build these before the try so they're accessible in the catch for rollback.
    const undoChanges = autoNumPreview.map(({ zone, newSectionNum, newSortOrder }) => ({
      id: zone.id,
      before: {
        sectionNum: zone.sectionNum,
        ...(autoNumSyncSortOrder ? { sortOrder: zone.sortOrder } : {}),
      } as MetaSnap,
      after: {
        sectionNum: newSectionNum,
        ...(autoNumSyncSortOrder ? { sortOrder: newSortOrder } : {}),
      } as MetaSnap,
    }));
    // Two-phase apply to avoid (aisleId, sectionNum) unique constraint
    // violations when new numbers overlap current numbers in the same aisle
    // (e.g. a cyclic swap: A:1→2, B:2→1).
    //
    // Phase 1 — park every zone at a temporary negative sentinel that is
    //            guaranteed not to collide with anything.
    // Phase 2 — move each zone from its sentinel to its final sectionNum,
    //            and (when sortOrder sync is enabled) also update sortOrder.
    const sentinelMap = buildAutoNumSentinelMap(autoNumPreview, zones);
    let phase1Done = false;

    setAutoNumApplying(true);
    try {
      for (const { id, sentinel } of sentinelMap) {
        await patchZone(id, { sectionNum: sentinel });
      }
      phase1Done = true;

      for (const { id, newSectionNum } of sentinelMap) {
        const preview = autoNumPreview.find((p) => p.zone.id === id)!;
        const patch: Partial<Zone> = { sectionNum: newSectionNum };
        if (autoNumSyncSortOrder) patch.sortOrder = preview.newSortOrder;
        await patchZone(id, patch);
      }
      // IMPORTANT: pushUndo must remain here — after BOTH phases have fully
      // succeeded — and must never be moved before the try/catch or before the
      // Phase 2 loop.  If it were called before Phase 2 (or before the catch
      // path is known to be unreachable), a subsequent failure would leave an
      // undo entry that describes a state transition that never completed,
      // producing corrupt undo behaviour (the "before" snapshot would match
      // the sentinel values, not the real originals).
      pushUndo({ type: "multiEdit", changes: undoChanges });
      // Keep lastSavedFormRef consistent so the dup-conflict suppression doesn't fire
      if (selectedId) {
        const hit = autoNumPreview.find((p) => p.zone.id === selectedId);
        if (hit && lastSavedFormRef.current) {
          lastSavedFormRef.current = { ...lastSavedFormRef.current, sectionNum: hit.newSectionNum };
        }
      }
      const n = autoNumPreview.length;
      toast.success(`Auto-numbered ${n} zone${n !== 1 ? "s" : ""}`);
      await fetchZones();
    } catch (e) {
      // Always re-sync the UI so the map reflects actual DB state, not stale local state.
      await fetchZones().catch(() => {});

      // Best-effort sentinel rollback: if Phase 1 ran but Phase 2 threw, some zones
      // may be stuck at their negative sentinel values. Restore them to their originals.
      if (phase1Done) {
        try {
          const res = await fetch(`${API_BASE}/warehouse-zones`);
          if (res.ok) {
            const data = await res.json() as { zones?: Zone[] };
            const freshZones: Zone[] = data.zones ?? [];
            const sentinelById = new Map(sentinelMap.map(({ id, sentinel }) => [id, sentinel]));
            const originals = new Map(undoChanges.map(({ id, before }) => [id, before.sectionNum]));
            const stillAtSentinel = freshZones.filter(
              (z) => sentinelById.has(z.id) && z.sectionNum === sentinelById.get(z.id),
            );
            if (stillAtSentinel.length > 0) {
              for (const z of stillAtSentinel) {
                const orig = originals.get(z.id);
                if (orig !== undefined) {
                  await patchZone(z.id, { sectionNum: orig }).catch(() => {});
                }
              }
              await fetchZones().catch(() => {});
              toast.error(
                `Auto-numbering failed and was rolled back. ${e instanceof Error ? e.message : String(e)}`,
              );
              return;
            }
          }
        } catch {
          // Rollback attempt itself failed — fall through to show the original error.
        }
      }

      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoNumApplying(false);
    }
  };

  const copyCoords = () => {
    const zone = zones.find((z) => z.id === selectedId);
    if (!zone) return;
    const txt = `${zone.svgX.toFixed(2)} ${zone.svgY.toFixed(2)} ${zone.svgWidth.toFixed(2)} ${zone.svgHeight.toFixed(2)}`;
    void navigator.clipboard.writeText(txt).then(() =>
      toast.success("SVG coords copied to clipboard")
    );
  };

  // Sync single-select form when selected zone changes.
  // Also flushes unsaved changes for the previously selected zone in cases where
  // the container onBlur didn't fire (e.g. Escape to deselect, programmatic
  // selection changes). In the common click-another-zone path the onBlur fires
  // first and optimistically sets lastSavedFormRef, so this call becomes a no-op
  // via the equality check inside flushSave.
  useEffect(() => {
    const prevId = prevSelectedIdRef.current;

    if (!selectedId) {
      // Zone was deselected — flush unsaved changes for the previous zone.
      if (prevId !== null) {
        const pending = zoneFormRef.current?.getCommittedForm() ?? formRef.current;
        if (lastSavedFormRef.current && JSON.stringify(pending) !== JSON.stringify(lastSavedFormRef.current)) {
          void flushSave(pending, prevId);
        }
        prevSelectedIdRef.current = null;
      }
      setDraftOffer(null);
      return;
    }

    const z = zones.find((z) => z.id === selectedId);
    if (!z) return;

    // Switching to a different zone — flush unsaved changes for previous zone.
    // Use getCommittedForm() so that a section-number value typed but not yet
    // committed to React state (field focused, not yet blurred) is captured.
    if (prevId !== null && prevId !== selectedId) {
      const pending = zoneFormRef.current?.getCommittedForm() ?? formRef.current;
      if (lastSavedFormRef.current && JSON.stringify(pending) !== JSON.stringify(lastSavedFormRef.current)) {
        void flushSave(pending, prevId);
      }
    }

    const synced: FormState = { aisleId: z.aisleId, sectionNum: z.sectionNum, isInventory: z.isInventory, sortOrder: z.sortOrder };
    prevSelectedIdRef.current = selectedId;
    setForm(synced);
    lastSavedFormRef.current = synced;

    // Check for a crash-recovery draft and offer to restore it if it differs
    // from the current server state.
    const draft = readDraft(selectedId);
    if (draft && JSON.stringify(draft.form) !== JSON.stringify(synced)) {
      setDraftOffer({ zoneId: selectedId, form: draft.form, savedAt: draft.savedAt });
    } else {
      if (draft) clearDraft(selectedId); // draft already matches server — discard silently
      setDraftOffer(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, zones]);

  // Mixed-value indicators for multi-select form
  const multiAisleIds = useMemo(
    () => new Set(selectedZoneList.map((z) => z.aisleId)),
    [selectedZoneList],
  );
  const multiSectionNums = useMemo(
    () => new Set(selectedZoneList.map((z) => z.sectionNum)),
    [selectedZoneList],
  );

  // Flush pending multi-select edits whenever the selection leaves multi-select
  // (or switches to a different multi-selection). This runs BEFORE the sync
  // effect below so multiAisleId/multiSectionNum still hold the edited values.
  // idsOverride passes the previous selection so the patch targets the correct zones.
  useEffect(() => {
    const prevIds = prevMultiSelectedIdsRef.current;
    prevMultiSelectedIdsRef.current = isMulti ? selectedIds : new Set();
    if (prevIds.size < 2) return; // wasn't in multi-select before
    // Still in multi-select with the exact same set? (zones change re-fires deps) — skip.
    if (isMulti && prevIds.size === selectedIds.size && [...prevIds].every((id) => selectedIds.has(id))) return;
    // Leaving multi-select or changing the multi-selection — flush pending edits.
    void handleMultiAutoSave(prevIds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, isMulti]);

  // Sync multi-select form fields when selection or zones change
  useEffect(() => {
    if (!isMulti) return;
    const list = zones.filter((z) => selectedIds.has(z.id));
    if (list.length === 0) return;
    const aisles = new Set(list.map((z) => z.aisleId));
    const sectionNums = new Set(list.map((z) => z.sectionNum));
    const syncedAisle = aisles.size === 1 ? [...aisles][0]! : "";
    const syncedSectionNum = sectionNums.size === 1 ? sectionNumToDisplay([...sectionNums][0]!) : "";
    setMultiAisleId(syncedAisle);
    setMultiSectionNum(syncedSectionNum);
    lastMultiAisleIdRef.current = syncedAisle;
    lastMultiSectionNumRef.current = syncedSectionNum;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, zones, isMulti]);

  // Auto-save when single-select form fields change (debounced 600 ms)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!selectedId || !lastSavedFormRef.current) return;
    if (pendingRect) return;
    if (!form.aisleId.trim()) return;
    if (!isValidAisleId(form.aisleId)) return;
    if (JSON.stringify(form) === JSON.stringify(lastSavedFormRef.current)) return;

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    // Capture mutable values for the timer closure.
    const capturedId = selectedId;
    const capturedForm = form;
    autoSaveTimerRef.current = setTimeout(async () => {
      const beforeMeta: MetaSnap = lastSavedFormRef.current ? { ...lastSavedFormRef.current } : {};
      try {
        const afterMeta: MetaSnap = {
          aisleId: normalizeAisleId(capturedForm.aisleId),
          sectionNum: capturedForm.sectionNum,
          isInventory: capturedForm.isInventory,
          sortOrder: capturedForm.sortOrder,
        };
        await patchZone(capturedId, afterMeta);
        clearDraft(capturedId);
        pushUndo({ type: "edit", id: capturedId, before: beforeMeta, after: afterMeta });
        lastSavedFormRef.current = { ...capturedForm };
        toast.success("Saved");
        await fetchZones();
      } catch (e) {
        // Server unreachable — save the form locally so the user can recover it.
        writeDraft(capturedId, capturedForm);
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }, 600);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [form, selectedId, pendingRect]);

  // ── beforeunload guard: flush unsaved form changes on tab close / navigation ──
  // Covers two scenarios:
  //   1. Tab close or browser refresh (native beforeunload)
  //   2. In-app navigation via <a href> links (also triggers a full-page reload,
  //      so beforeunload fires here too — App.tsx uses <a href>, not a client router)
  //
  // All reads go through refs so the handler never captures stale state.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const ids = [...selectedIdsRef.current];
      const currentSelectedId = ids.length === 1 ? ids[0] : null;
      const hasPendingTimer = autoSaveTimerRef.current !== null;
      const formIsDirty =
        currentSelectedId !== null &&
        lastSavedFormRef.current !== null &&
        JSON.stringify(formRef.current) !== JSON.stringify(lastSavedFormRef.current);

      if (!formIsDirty && !hasPendingTimer) return;

      // Best-effort keepalive PATCH so data survives even if the user confirms "Leave".
      if (formIsDirty && currentSelectedId !== null) {
        const pending = formRef.current;
        if (pending.aisleId.trim() && isValidAisleId(pending.aisleId)) {
          // Persist to localStorage first as a crash-recovery draft — if the
          // keepalive PATCH fails (server down) the user can restore on reload.
          writeDraft(currentSelectedId, pending);
          const afterMeta = {
            aisleId: normalizeAisleId(pending.aisleId),
            sectionNum: pending.sectionNum,
            isInventory: pending.isInventory,
            sortOrder: pending.sortOrder,
          };
          void fetch(`${API_BASE}/warehouse-zones/${currentSelectedId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(afterMeta),
            keepalive: true,
          }).then((r) => {
            // If the keepalive PATCH succeeded the data is in the DB — remove draft.
            if (r.ok) clearDraft(currentSelectedId);
          }).catch(() => { /* draft stays — server was unreachable */ });
        }
      }

      // Show the browser's native "Leave site?" dialog so the user has a chance
      // to stay if they navigated away accidentally.
      e.preventDefault();
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // ── SVG coordinate utility ──────────────────────────────────────────────────
  // Returns a point in zone coordinate space (raw svgX/svgY space used by all
  // stored zone coordinates).  Two transforms are inverted in sequence:
  //   1. tf    — the pan/zoom canvas transform
  //   2. align — the zone-layer calibration offset
  // Both are read from refs so the callback stays stable across renders.
  const getSvgPt = useCallback((clientX: number, clientY: number): Pt => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const svgPt = screenToSvg(clientX, clientY, rect, tfRef.current);
    const a = alignRef.current;
    return {
      x: (svgPt.x - a.x) / a.s,
      y: (svgPt.y - a.y) / a.s,
    };
  }, []);

  // ── Rubber-band selection (Shift+drag) ─────────────────────────────────────
  const { rubberRect, onSvgMouseDown: onRubberMouseDown } = useRubberBand({
    zonesRef,
    tfRef,
    getSvgPt,
    selectedIds,
    setSelectedIds,
    setPendingRect,
    // Rubber-band has no pointer sequence — append newly-hit IDs in sortOrder/svgY
    // order (the order they arrive from hitTestZones via zonesRef) after any
    // previously-selected IDs, matching the existing fallback sort in buildAutoNumPreview.
    onRubberBandSelect: (newIds) => {
      setSelectionOrder((prev) => {
        const prevSet = new Set(prev);
        const toAdd = newIds.filter((id) => !prevSet.has(id));
        return [...prev, ...toAdd];
      });
    },
  });

  // ── Fill-mode click handler ─────────────────────────────────────────────────
  // Stable callback (reads from refs) — safe to call from any event handler.
  const handleFillClickRef = useRef<(clientX: number, clientY: number) => Promise<void>>(
    async () => { /* placeholder before first render */ }
  );

  const handleFillClick = useCallback(async (clientX: number, clientY: number) => {
    // Re-entrancy guard: ignore concurrent fill requests.
    // Set the ref synchronously so a rapid second click is blocked immediately,
    // before React has a chance to flush the setFillLoading(true) state update
    // and re-run the useEffect that keeps fillLoadingRef in sync.
    if (fillLoadingRef.current) return;
    fillLoadingRef.current = true;
    setFillLoading(true);
    try {
      // Seed point must be in floor-plan SVG space (what rasterizeSvg/floodFillBounds
      // operate on), so invert only tf — do NOT invert align here.
      const pt = svgRef.current
        ? screenToSvg(clientX, clientY, svgRef.current.getBoundingClientRect(), tfRef.current)
        : { x: 0, y: 0 };
      const dims = svgDimsRef.current;

      // Compute raster pixel coordinates from SVG user-unit click position.
      // Rasterisation and BFS run on the main thread using a 1024-px-wide canvas.
      const maxPx = 1024;
      const aspect = dims.h / dims.w;
      const cw = Math.min(Math.round(dims.w), maxPx);
      const ch = Math.max(1, Math.round(cw * aspect));
      const px = Math.round((pt.x / dims.w) * cw);
      const py = Math.round((pt.y / dims.h) * ch);

      const darkThreshold = sliderToThreshold(fillSensitivityRef.current);

      // Run rasterise + BFS on the main thread. The 1024-px raster completes
      // in well under 100 ms for typical floor plans — no perceptible jank.
      const raster = await rasterizeSvg(svgInnerRef.current, dims);
      const bounds = floodFillBounds(raster.imageData, px, py, darkThreshold);

      if (!bounds) {
        toast.error("Click inside a light area, not on a wall or line.");
        return;
      }

      // Convert pixel bounding box to zone coordinate space (raw svgX/svgY).
      // Step 1: pixel → SVG user units
      const scaleX = dims.w / cw;
      const scaleY = dims.h / ch;
      const svgRect = {
        x: bounds.x * scaleX,
        y: bounds.y * scaleY,
        w: bounds.w * scaleX,
        h: bounds.h * scaleY,
      };
      // Step 2: SVG user units → zone coords (invert align transform)
      const a = alignRef.current;
      const rect = {
        x: (svgRect.x - a.x) / a.s,
        y: (svgRect.y - a.y) / a.s,
        w: svgRect.w / a.s,
        h: svgRect.h / a.s,
      };

      // Flash the detected rectangle as a fillFlashRect (~300 ms) for visual feedback.
      setFillFlashRect(rect);
      await new Promise<void>((r) => setTimeout(r, 300));
      setFillFlashRect(null);

      // Commit as pendingRect — opens the sidebar form (same flow as Draw mode).
      setPendingRect(rect);
      setSelectedIds(new Set());
      setSelectionOrder([]);
      setForm({ aisleId: "", sectionNum: null, isInventory: true, sortOrder: 0 });

      // Auto-switch back to Pan so a stray click doesn't trigger another fill.
      setMode("pan");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Fill failed");
    } finally {
      // Reset the ref synchronously so the guard is lifted immediately,
      // matching the synchronous set at the top of the function.
      fillLoadingRef.current = false;
      setFillLoading(false);
    }
  }, []);

  // Keep the ref in sync so onSvgMouseDown always calls the latest version.
  useEffect(() => { handleFillClickRef.current = handleFillClick; }, [handleFillClick]);

  // ── Document-level mouse handlers (global capture for drag reliability) ─────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const state = ixRef.current;
      if (state.t === "idle") return;

      if (state.t === "pan") {
        const newTf = {
          ...tfRef.current,
          x: state.tx + (e.clientX - state.sx),
          y: state.ty + (e.clientY - state.sy),
        };
        tfRef.current = newTf;
        setTf({ ...newTf });
        return;
      }

      if (state.t === "alignPan") {
        // Screen delta → SVG-unit delta (align lives inside the tf transform).
        const s = tfRef.current.s || 1;
        setAlign((prev) => ({
          ...prev,
          x: state.ax + (e.clientX - state.sx) / s,
          y: state.ay + (e.clientY - state.sy) / s,
        }));
        return;
      }

      const p = getSvgPt(e.clientX, e.clientY);

      if (state.t === "draw") {
        ixRef.current = { ...state, x2: p.x, y2: p.y };
        const r = normRectUtil(state.x1, state.y1, p.x, p.y);
        setDraftRect({ x: r.svgX, y: r.svgY, w: r.svgWidth, h: r.svgHeight });
        return;
      }

      if (state.t === "move") {
        const base = zonesRef.current.find((z) => z.id === state.id);
        if (!base) return;
        const updated = { ...base, svgX: p.x - state.ox, svgY: p.y - state.oy };
        dragZoneRef.current = updated;
        setDragZone(updated);
        return;
      }

      if (state.t === "resize") {
        const base = zonesRef.current.find((z) => z.id === state.id);
        if (!base) return;
        const minSvg = MIN_ZONE_PX / tfRef.current.s;
        let updated: Zone;
        const h = state.handle;
        if (h === "n") {
          const bottom = base.svgY + base.svgHeight;
          const newY = Math.min(p.y, bottom - minSvg);
          updated = { ...base, svgY: newY, svgHeight: bottom - newY };
        } else if (h === "s") {
          updated = { ...base, svgHeight: Math.max(minSvg, p.y - base.svgY) };
        } else if (h === "e") {
          updated = { ...base, svgWidth: Math.max(minSvg, p.x - base.svgX) };
        } else if (h === "w") {
          const right = base.svgX + base.svgWidth;
          const newX = Math.min(p.x, right - minSvg);
          updated = { ...base, svgX: newX, svgWidth: right - newX };
        } else {
          const r = normRectUtil(state.ax, state.ay, p.x, p.y);
          updated = { ...base, ...r };
        }
        dragZoneRef.current = updated;
        setDragZone(updated);
        return;
      }

      if (state.t === "multiMove") {
        const delta = { x: p.x - state.startX, y: p.y - state.startY };
        setMultiDragDelta(delta);
      }
    };

    const onUp = async (e: MouseEvent) => {
      const state = ixRef.current;
      ixRef.current = { t: "idle" };

      if (state.t === "pan") {
        const dx = e.clientX - state.sx;
        const dy = e.clientY - state.sy;
        if (Math.hypot(dx, dy) < 5) {
          setSelectedIds(new Set());
          setSelectionOrder([]);
          setPendingRect(null);
        }
        return;
      }

      if (state.t === "draw") {
        const r = normRectUtil(state.x1, state.y1, state.x2, state.y2);
        const minSvg = MIN_ZONE_PX / tfRef.current.s;
        setDraftRect(null);
        if (r.svgWidth < minSvg || r.svgHeight < minSvg) {
          setSelectedIds(new Set());
          setSelectionOrder([]);
          setPendingRect(null);
          return;
        }
        setPendingRect({ x: r.svgX, y: r.svgY, w: r.svgWidth, h: r.svgHeight });
        setSelectedIds(new Set());
        setSelectionOrder([]);
        setForm({ aisleId: "", sectionNum: null, isInventory: true, sortOrder: 0 });
        return;
      }

      // Fill: only trigger if the pointer barely moved (< 5 px) — true click, not drag.
      if (state.t === "fillPending") {
        const dx = e.clientX - state.sx;
        const dy = e.clientY - state.sy;
        if (Math.hypot(dx, dy) < 5) {
          void handleFillClickRef.current(state.sx, state.sy);
        }
        return;
      }

      if ((state.t === "move" || state.t === "resize") && dragZoneRef.current) {
        const zone = dragZoneRef.current;
        const original = zonesRef.current.find((z) => z.id === zone.id);
        try {
          if (state.t === "move") {
            await patchZone(zone.id, { svgX: zone.svgX, svgY: zone.svgY });
            if (original) pushUndo({ type: "move", id: zone.id, before: { svgX: original.svgX, svgY: original.svgY }, after: { svgX: zone.svgX, svgY: zone.svgY } });
            toast.success("Position saved");
          } else {
            await patchZone(zone.id, { svgX: zone.svgX, svgY: zone.svgY, svgWidth: zone.svgWidth, svgHeight: zone.svgHeight });
            if (original) pushUndo({ type: "resize", id: zone.id, before: { svgX: original.svgX, svgY: original.svgY, svgWidth: original.svgWidth, svgHeight: original.svgHeight }, after: { svgX: zone.svgX, svgY: zone.svgY, svgWidth: zone.svgWidth, svgHeight: zone.svgHeight } });
            toast.success("Size saved");
          }
          await fetch(`${API_BASE}/warehouse-zones`)
            .then((r) => r.json())
            .then((d) => {
              setZones(d.zones ?? []);
              setDragZone(null);
            });
        } catch (err) {
          setDragZone(null);
          toast.error(err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (state.t === "multiMove") {
        const origins = multiDragOriginsRef.current;
        // Only save if there was actual movement
        const currentDelta = (() => {
          if (!svgRef.current) return null;
          const rect = svgRef.current.getBoundingClientRect();
          const svgPt = screenToSvg(e.clientX, e.clientY, rect, tfRef.current);
          const a = alignRef.current;
          const p = { x: (svgPt.x - a.x) / a.s, y: (svgPt.y - a.y) / a.s };
          return { x: p.x - state.startX, y: p.y - state.startY };
        })();
        setMultiDragDelta(null);
        if (!currentDelta || (Math.abs(currentDelta.x) < 0.5 && Math.abs(currentDelta.y) < 0.5)) return;
        // Use allSettled so a partial failure is surfaced rather than silently lost.
        const results = await Promise.allSettled(
          [...origins.entries()].map(([id, orig]) =>
            patchZone(id, { svgX: orig.x + currentDelta.x, svgY: orig.y + currentDelta.y }),
          ),
        );
        const failCount = results.filter((r) => r.status === "rejected").length;
        const okCount = results.length - failCount;
        if (failCount === 0) {
          pushUndo({
            type: "batchMove",
            moves: [...origins.entries()].map(([id, orig]) => ({
              id,
              before: { svgX: orig.x, svgY: orig.y },
              after: { svgX: orig.x + currentDelta.x, svgY: orig.y + currentDelta.y },
            })),
          });
          toast.success(`Moved ${origins.size} zone${origins.size !== 1 ? "s" : ""}`);
        } else {
          toast.error(
            `${okCount} zone${okCount !== 1 ? "s" : ""} moved, ${failCount} failed — check network`,
          );
        }
        // Always refetch to restore consistent UI state after partial failures.
        await fetch(`${API_BASE}/warehouse-zones`)
          .then((r) => r.json())
          .then((d) => { setZones(d.zones ?? []); });
        return;
      }

      void e; // suppress unused warning
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp as EventListener);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp as EventListener);
    };
  }, [getSvgPt, patchZone, pushUndo]);

  // ── React event handlers (attached to SVG element) ──────────────────────────
  const onSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (modeRef.current === "pan") {
      if (e.shiftKey) {
        // Shift+drag → delegate entirely to the useRubberBand hook.
        onRubberMouseDown(e);
        return;
      }
      ixRef.current = {
        t: "pan",
        sx: e.clientX, sy: e.clientY,
        tx: tfRef.current.x, ty: tfRef.current.y,
      };
    } else if (modeRef.current === "fill") {
      setDraftRect(null);
      // Record screen position; the actual fill fires on mouseup if movement < 5px.
      // This prevents accidental fills when the user was just trying to pan.
      // Do NOT clear pendingRect here — a failed fill (wall click) should leave
      // any previously drawn pending rect visible.
      ixRef.current = { t: "fillPending", sx: e.clientX, sy: e.clientY };
    } else if (modeRef.current === "calibrate") {
      // Drag the whole zone layer. Delta is applied in SVG units (screen / tf.s)
      // in the move handler; capture the align translate at drag start here.
      ixRef.current = {
        t: "alignPan",
        sx: e.clientX, sy: e.clientY,
        ax: alignRef.current.x, ay: alignRef.current.y,
      };
    } else {
      const p = getSvgPt(e.clientX, e.clientY);
      ixRef.current = { t: "draw", x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 });
      setPendingRect(null);
    }
  };

  const onZoneMouseDown = (e: React.MouseEvent, zone: Zone) => {
    // In Fill mode, don't intercept — let the event reach onSvgMouseDown
    // so the flood-fill triggers normally even when clicking over a zone.
    // In Calibrate mode, individual zones are not editable — let the event
    // reach onSvgMouseDown so dragging starts a whole-layer pan instead.
    if (modeRef.current === "fill" || modeRef.current === "calibrate") return;
    e.stopPropagation();
    if (e.button !== 0) return;

    if (e.shiftKey) {
      // Shift+click: toggle zone in/out of multi-selection
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(zone.id)) next.delete(zone.id);
        else next.add(zone.id);
        return next;
      });
      setSelectionOrder((prev) => {
        if (prev.includes(zone.id)) return prev.filter((id) => id !== zone.id);
        return [...prev, zone.id];
      });
      setPendingRect(null);
      return; // don't start move for shift-clicks
    }

    // If clicking a zone that's already part of the multi-selection, start
    // a multi-move drag so all selected zones move together.
    if (selectedIdsRef.current.size > 1 && selectedIdsRef.current.has(zone.id)) {
      // Cancel any pending auto-save before starting a drag
      if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
      const p = getSvgPt(e.clientX, e.clientY);
      // Snapshot the current positions of all selected zones
      const origins = new Map<number, Pt>();
      for (const z of zonesRef.current) {
        if (selectedIdsRef.current.has(z.id)) {
          origins.set(z.id, { x: z.svgX, y: z.svgY });
        }
      }
      multiDragOriginsRef.current = origins;
      setMultiDragDelta(null);
      ixRef.current = { t: "multiMove", startX: p.x, startY: p.y };
      return;
    }

    // Plain click: single-select and start move
    // Cancel any pending auto-save before the position drag fires its own PATCH
    if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    setSelectedIds(new Set([zone.id]));
    setSelectionOrder([zone.id]);
    setPendingRect(null);
    const p = getSvgPt(e.clientX, e.clientY);
    ixRef.current = {
      t: "move",
      id: zone.id,
      ox: p.x - zone.svgX,
      oy: p.y - zone.svgY,
    };
  };

  const onHandleMouseDown = (
    e: React.MouseEvent,
    zone: Zone,
    handle: Handle,
  ) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    // Cancel any pending auto-save so the resize PATCH doesn't interleave with it
    if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    const anchor = ANCHOR[handle](zone);
    ixRef.current = {
      t: "resize",
      id: zone.id,
      handle,
      ax: anchor.x,
      ay: anchor.y,
    };
  };

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const newTf = computeWheelZoom(tfRef.current, mx, my, e.deltaY);
    tfRef.current = newTf;
    setTf({ ...newTf });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // ── Derived rendering values ─────────────────────────────────────────────────
  const hs = HANDLE_PX / tf.s; // handle size in SVG user units (constant screen pixels)
  const sw = 1.2 / tf.s; // stroke width in SVG user units

  // Merge drag-modified zone(s) into the zone list for rendering
  const displayZones = useMemo(() => {
    if (dragZone) return zones.map((z) => (z.id === dragZone.id ? dragZone : z));
    if (multiDragDelta) {
      return zones.map((z) => {
        if (!selectedIds.has(z.id)) return z;
        const orig = multiDragOriginsRef.current.get(z.id);
        if (!orig) return z;
        return { ...z, svgX: orig.x + multiDragDelta.x, svgY: orig.y + multiDragDelta.y };
      });
    }
    return zones;
  }, [zones, dragZone, multiDragDelta, selectedIds]);

  // ── Auto-number computed values ────────────────────────────────────────────
  // Selected zones ordered by selection sequence (or sortOrder/svgY fallback for rubber-band).
  const autoNumPreview = useMemo(
    () => buildAutoNumPreview(zones, selectedIds, autoNumStart, autoNumIncrement, autoNumDigits, selectionOrder),
    [zones, selectedIds, autoNumStart, autoNumIncrement, autoNumDigits, selectionOrder],
  );

  // Live collision check — recomputed whenever the preview or zone list changes.
  const liveCollisions = useMemo(
    () => buildAutoNumCollisions(autoNumPreview, zones, selectedIds),
    [autoNumPreview, zones, selectedIds],
  );

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      <Toaster position="bottom-right" richColors />

      {/* ── Branded Confirm Dialog ─────────────────────────────────────────── */}
      {confirmState.visible && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
          backgroundColor: "rgba(0,0,0,0.6)", padding: 24,
        }}>
          <div style={{
            backgroundColor: "#161b22",
            border: "1px solid #30363d",
            borderRadius: 8,
            padding: 24,
            maxWidth: 380,
            width: "100%",
            fontFamily: "Inter, system-ui, sans-serif",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}>
            <div style={{
              fontSize: 16,
              fontWeight: 700,
              color: "#f9fafb",
              marginBottom: 8,
            }}>
              {confirmState.title}
            </div>
            {confirmState.message && (
              <div style={{
                fontSize: 13,
                color: "#8b949e",
                lineHeight: 1.5,
                marginBottom: 20,
              }}>
                {confirmState.message}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => handleConfirmResponse(false)}
                style={{
                  padding: "8px 18px", borderRadius: 8, border: "1px solid #30363d",
                  background: "transparent", color: "#8b949e",
                  fontSize: 13, fontFamily: "Inter, system-ui, sans-serif",
                  cursor: "pointer", fontWeight: 500,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirmResponse(true)}
                style={{
                  padding: "8px 18px", borderRadius: 8, border: "none",
                  background: confirmState.destructive ? "#f85149" : "#f59e0b",
                  color: confirmState.destructive ? "#ffffff" : "#0d1117",
                  fontSize: 13, fontFamily: "Inter, system-ui, sans-serif",
                  cursor: "pointer", fontWeight: 700,
                }}
              >
                {confirmState.destructive ? "Delete" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dev-tool banner ─────────────────────────────────────────────────── */}
      <div style={styles.banner}>
        <a href="/__mockup" style={styles.backLink}>← Internal Tools</a>
        <span style={{ fontWeight: 600 }}>
          ⚠ DEV TOOL — Warehouse Zone Editor — internal use only
        </span>
        <div style={styles.modeBar}>
          <ModeBtn active={mode === "pan"} onClick={() => { setMode("pan"); }}>
            Pan / Select
          </ModeBtn>
          <ModeBtn active={mode === "draw"} onClick={() => { setMode("draw"); setSelectedIds(new Set()); setSelectionOrder([]); setPendingRect(null); setForm({ aisleId: "", sectionNum: null, isInventory: true, sortOrder: 0 }); }}>
            Draw Zone
          </ModeBtn>
          <ModeBtn active={mode === "fill"} onClick={() => { setMode("fill"); setSelectedIds(new Set()); setSelectionOrder([]); setPendingRect(null); }}>
            ⬛ Fill
          </ModeBtn>
          <ModeBtn active={mode === "calibrate"} onClick={() => { setMode("calibrate"); setSelectedIds(new Set()); setSelectionOrder([]); setPendingRect(null); setDraftRect(null); }}>
            ✛ Calibrate
          </ModeBtn>
          <div style={{ width: 1, background: "rgba(255,255,255,0.3)", margin: "0 2px" }} />
          <button
            title={undoCount > 0 ? `Undo (${undoCount})` : "Nothing to undo"}
            disabled={undoCount === 0}
            onClick={() => { void applyUndoRedoRef.current?.("undo"); }}
            style={{
              position: "relative",
              padding: "3px 8px",
              borderRadius: 4,
              background: "transparent",
              color: undoCount > 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.3)",
              border: "1px solid rgba(255,255,255,0.5)",
              cursor: undoCount > 0 ? "pointer" : "default",
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ↩{undoCount > 0 && (
              <span style={{
                position: "absolute",
                top: -6,
                right: -6,
                background: "#4a9eff",
                color: "#fff",
                borderRadius: 8,
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1,
                minWidth: 14,
                height: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0 3px",
                pointerEvents: "none",
              }}>
                {undoCount > 99 ? "99+" : undoCount}
              </span>
            )}
          </button>
          <button
            title={redoCount > 0 ? `Redo (${redoCount})` : "Nothing to redo"}
            disabled={redoCount === 0}
            onClick={() => { void applyUndoRedoRef.current?.("redo"); }}
            style={{
              padding: "3px 8px",
              borderRadius: 4,
              background: "transparent",
              color: redoCount > 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.3)",
              border: "1px solid rgba(255,255,255,0.5)",
              cursor: redoCount > 0 ? "pointer" : "default",
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ↪
          </button>
          <button
            title={selectedIds.size > 0 ? `Clear §number for ${selectedIds.size} selected zone${selectedIds.size !== 1 ? "s" : ""}` : "Select zones first"}
            disabled={selectedIds.size === 0}
            onClick={() => { void handleResetSectionNumToNull(); }}
            style={{
              padding: "3px 9px",
              borderRadius: 4,
              background: selectedIds.size > 0 ? "rgba(107,114,128,0.18)" : "transparent",
              color: selectedIds.size > 0 ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.3)",
              border: `1px solid ${selectedIds.size > 0 ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.3)"}`,
              cursor: selectedIds.size > 0 ? "pointer" : "default",
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            Reset §
          </button>
        </div>
        {mode === "fill" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
            <label style={{ fontSize: 11, color: "#ddd", whiteSpace: "nowrap" }}>
              Sensitivity:
            </label>
            {/* Slider + tick marks */}
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <input
                type="range"
                min={0} max={100} step={1}
                value={fillSensitivity}
                onChange={(e) => setFillSensitivity(Number(e.target.value))}
                style={{
                  width: 196,
                  margin: 0,
                  accentColor: "#f59e0b",
                  cursor: "pointer",
                }}
              />
              {/* Clickable preset ticks — positioned to match the slider track */}
              <div style={{ position: "relative", width: 196, height: 22, marginTop: 1 }}>
                {FILL_PRESETS.map(({ pos, label, short }) => {
                  const active = fillSensitivity === pos;
                  // The range thumb is centered at 0% and 100%, with ~8px inset
                  // on each side. Track width ≈ 196 - 16 = 180px.
                  const leftPx = 8 + (pos / 100) * 180;
                  return (
                    <button
                      key={pos}
                      title={label}
                      onClick={() => setFillSensitivity(pos)}
                      style={{
                        position: "absolute",
                        left: leftPx,
                        top: 0,
                        transform: "translateX(-50%)",
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 1,
                      }}
                    >
                      <div style={{
                        width: active ? 2 : 1,
                        height: active ? 6 : 4,
                        background: active ? "#f59e0b" : "rgba(255,255,255,0.4)",
                        borderRadius: 1,
                      }} />
                      <span style={{
                        fontSize: 8,
                        lineHeight: 1.1,
                        color: active ? "#f59e0b" : "rgba(255,255,255,0.45)",
                        fontWeight: active ? 700 : 400,
                        whiteSpace: "nowrap",
                        userSelect: "none",
                      }}>
                        {short}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Active level name */}
            <span style={{
              fontSize: 11,
              color: "#f59e0b",
              whiteSpace: "nowrap",
              minWidth: 76,
              fontWeight: 500,
            }}>
              {FILL_PRESETS.find((p) => p.pos === fillSensitivity)?.label ?? "Custom"}
            </span>
          </div>
        )}
        {mode === "calibrate" && (() => {
          const dirty =
            align.x !== savedAlign.x || align.y !== savedAlign.y || align.s !== savedAlign.s;
          const xOutOfRange = align.x < -ALIGN_TRANSLATE_MAX || align.x > ALIGN_TRANSLATE_MAX;
          const yOutOfRange = align.y < -ALIGN_TRANSLATE_MAX || align.y > ALIGN_TRANSLATE_MAX;
          const sOutOfRange = align.s < ALIGN_SCALE_MIN || align.s > ALIGN_SCALE_MAX;
          const anyOutOfRange = xOutOfRange || yOutOfRange || sOutOfRange;
          const nudgeBtn = (label: string, dx: number, dy: number, title: string) => {
            const atLimit =
              (dx < 0 && align.x <= -ALIGN_TRANSLATE_MAX) ||
              (dx > 0 && align.x >= ALIGN_TRANSLATE_MAX) ||
              (dy < 0 && align.y <= -ALIGN_TRANSLATE_MAX) ||
              (dy > 0 && align.y >= ALIGN_TRANSLATE_MAX);
            return (
              <button
                key={title}
                title={atLimit ? `Already at limit (±${ALIGN_TRANSLATE_MAX})` : title}
                disabled={atLimit}
                onClick={() => nudgeAlign(dx, dy)}
                style={{
                  width: 28, height: 24, padding: 0, fontSize: 13, lineHeight: 1,
                  background: atLimit ? "#1e293b" : "#334155",
                  color: atLimit ? "#475569" : "#fff",
                  border: "1px solid #475569",
                  borderRadius: 4, cursor: atLimit ? "not-allowed" : "pointer",
                  opacity: atLimit ? 0.5 : 1,
                }}
              >
                {label}
              </button>
            );
          };
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 8, flexWrap: "wrap" }}>
              {/* Nudge — small step */}
              <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ fontSize: 10, color: "#94a3b8", marginRight: 2 }}>Nudge</span>
                {nudgeBtn("←", -ALIGN_NUDGE_SMALL, 0, `Left ${ALIGN_NUDGE_SMALL}`)}
                {nudgeBtn("→", ALIGN_NUDGE_SMALL, 0, `Right ${ALIGN_NUDGE_SMALL}`)}
                {nudgeBtn("↑", 0, -ALIGN_NUDGE_SMALL, `Up ${ALIGN_NUDGE_SMALL}`)}
                {nudgeBtn("↓", 0, ALIGN_NUDGE_SMALL, `Down ${ALIGN_NUDGE_SMALL}`)}
              </div>
              {/* Nudge — large step */}
              <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ fontSize: 10, color: "#94a3b8", marginRight: 2 }}>Big</span>
                {nudgeBtn("«", -ALIGN_NUDGE_LARGE, 0, `Left ${ALIGN_NUDGE_LARGE}`)}
                {nudgeBtn("»", ALIGN_NUDGE_LARGE, 0, `Right ${ALIGN_NUDGE_LARGE}`)}
                {nudgeBtn("⤒", 0, -ALIGN_NUDGE_LARGE, `Up ${ALIGN_NUDGE_LARGE}`)}
                {nudgeBtn("⤓", 0, ALIGN_NUDGE_LARGE, `Down ${ALIGN_NUDGE_LARGE}`)}
              </div>
              {/* Uniform scale */}
              <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ fontSize: 10, color: "#94a3b8", marginRight: 2 }}>Scale</span>
                <button title={`− ${ALIGN_SCALE_LARGE}`} onClick={() => scaleAlign(-ALIGN_SCALE_LARGE)} style={{ width: 28, height: 24, padding: 0, fontSize: 12, background: "#334155", color: "#fff", border: "1px solid #475569", borderRadius: 4, cursor: "pointer" }}>−−</button>
                <button title={`− ${ALIGN_SCALE_SMALL}`} onClick={() => scaleAlign(-ALIGN_SCALE_SMALL)} style={{ width: 24, height: 24, padding: 0, fontSize: 13, background: "#334155", color: "#fff", border: "1px solid #475569", borderRadius: 4, cursor: "pointer" }}>−</button>
                <span style={{ fontSize: 11, color: "#f59e0b", minWidth: 42, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{(align.s * 100).toFixed(0)}%</span>
                <button title={`+ ${ALIGN_SCALE_SMALL}`} onClick={() => scaleAlign(ALIGN_SCALE_SMALL)} style={{ width: 24, height: 24, padding: 0, fontSize: 13, background: "#334155", color: "#fff", border: "1px solid #475569", borderRadius: 4, cursor: "pointer" }}>+</button>
                <button title={`+ ${ALIGN_SCALE_LARGE}`} onClick={() => scaleAlign(ALIGN_SCALE_LARGE)} style={{ width: 28, height: 24, padding: 0, fontSize: 12, background: "#334155", color: "#fff", border: "1px solid #475569", borderRadius: 4, cursor: "pointer" }}>++</button>
              </div>
              {/* Offset readout */}
              <span style={{ fontSize: 10, fontVariantNumeric: "tabular-nums", display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: xOutOfRange ? "#f87171" : "#94a3b8" }}
                  title={xOutOfRange ? `X must be between −${ALIGN_TRANSLATE_MAX} and ${ALIGN_TRANSLATE_MAX}` : undefined}>
                  x {align.x.toFixed(1)}{xOutOfRange ? " ⚠" : ""}
                </span>
                <span style={{ color: "#475569" }}>·</span>
                <span style={{ color: yOutOfRange ? "#f87171" : "#94a3b8" }}
                  title={yOutOfRange ? `Y must be between −${ALIGN_TRANSLATE_MAX} and ${ALIGN_TRANSLATE_MAX}` : undefined}>
                  y {align.y.toFixed(1)}{yOutOfRange ? " ⚠" : ""}
                </span>
              </span>
              {/* Out-of-range warning banner */}
              {anyOutOfRange && (
                <span style={{ fontSize: 10, color: "#fbbf24", background: "#451a03", border: "1px solid #92400e", borderRadius: 4, padding: "2px 6px" }}>
                  {xOutOfRange && `X out of range (±${ALIGN_TRANSLATE_MAX})`}
                  {xOutOfRange && yOutOfRange && " · "}
                  {yOutOfRange && `Y out of range (±${ALIGN_TRANSLATE_MAX})`}
                  {(xOutOfRange || yOutOfRange) && sOutOfRange && " · "}
                  {sOutOfRange && `Scale out of range (${ALIGN_SCALE_MIN}–${ALIGN_SCALE_MAX})`}
                  {" — server will reject"}
                </span>
              )}
              {/* Actions */}
              <button
                title="Reset the offset to zero (no shift, 100% scale). Save to apply for all users."
                onClick={() => setAlign({ ...IDENTITY_ALIGN })}
                style={{ height: 24, padding: "0 8px", fontSize: 11, background: "#334155", color: "#fff", border: "1px solid #475569", borderRadius: 4, cursor: "pointer" }}
              >
                Reset to zero
              </button>
              <button
                title="Discard unsaved changes and revert to the last saved offset"
                disabled={!dirty || savingAlign}
                onClick={() => setAlign({ ...savedAlign })}
                style={{ height: 24, padding: "0 8px", fontSize: 11, background: "transparent", color: dirty ? "#cbd5e1" : "#64748b", border: "1px solid #475569", borderRadius: 4, cursor: dirty && !savingAlign ? "pointer" : "default" }}
              >
                Revert
              </button>
              <button
                title={anyOutOfRange ? `Values out of allowed bounds — fix before saving` : "Save this alignment globally — applies to every user's Map tab"}
                disabled={savingAlign || anyOutOfRange}
                onClick={() => { void saveAlignment(); }}
                style={{ height: 24, padding: "0 12px", fontSize: 11, fontWeight: 600, background: anyOutOfRange ? "#7f1d1d" : dirty ? "#16a34a" : "#334155", color: anyOutOfRange ? "#fca5a5" : "#fff", border: anyOutOfRange ? "1px solid #991b1b" : "none", borderRadius: 4, cursor: savingAlign || anyOutOfRange ? "default" : "pointer" }}
              >
                {savingAlign ? "Saving…" : anyOutOfRange ? "Out of range" : dirty ? "Save ●" : "Saved"}
              </button>
            </div>
          );
        })()}
        <span style={styles.hint}>
          scroll-zoom · {mode === "pan"
            ? "drag to pan · Shift+drag to select · Shift+click to multi-select · drag selected to move all"
            : mode === "fill"
              ? "click inside an enclosed area to auto-detect its bounds · switches back to Pan after each fill"
              : "drag to draw"}
          {" "}· {(tf.s * 100).toFixed(0)}%
        </span>
      </div>

      {/* ── Content area (below banner) ─────────────────────────────────────── */}
      <div style={styles.content}>
        {/* SVG canvas */}
        <div style={{ ...styles.canvas, position: "relative" }}>
          <svg
            ref={svgRef}
            overflow="hidden"
            style={{
              ...styles.svg,
              cursor: fillLoading
                ? "wait"
                : mode === "pan"
                  ? ixRef.current.t === "pan"
                    ? "grabbing"
                    : "grab"
                  : mode === "calibrate"
                    ? ixRef.current.t === "alignPan"
                      ? "grabbing"
                      : "grab"
                    : "crosshair",
            }}
            onMouseDown={onSvgMouseDown}
          >
            <g transform={`translate(${tf.x},${tf.y}) scale(${tf.s})`}>
              {/* Floor plan — embedded as a child <g> inside the SVG so it
                  shares the same coordinate system as zone overlays and stays
                  perfectly crisp at any zoom level (no rasterisation). */}
              <g ref={floorPlanRef} pointerEvents="none" />

              {/* Zone overlays.
                  The whole zone layer is shifted/scaled by the saved alignment offset
                  so zones always land on the floor plan at their calibrated position.
                  getSvgPt inverts both tf and align, keeping pointer↔zone math exact. */}
              <g transform={`translate(${align.x},${align.y}) scale(${align.s})`}>
              {displayZones.map((zone) => {
                const sel = selectedIds.has(zone.id);
                const fill = zone.isInventory
                  ? "rgba(0, 112, 255, 0.14)"
                  : "rgba(0, 112, 255, 0.06)";
                const stroke = sel ? "#f59e0b" : "#0070ff";
                // Corner handles only for single-selected zone
                const showHandles = sel && selectedIds.size === 1;
                return (
                  <g key={zone.id}>
                    <rect
                      x={zone.svgX}
                      y={zone.svgY}
                      width={zone.svgWidth}
                      height={zone.svgHeight}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={sel ? sw * 1.5 : sw}
                      strokeDasharray={
                        zone.isInventory ? undefined : `${12 / tf.s} ${6 / tf.s}`
                      }
                      onMouseDown={(e) => onZoneMouseDown(e, zone)}
                      style={{ cursor: sel && selectedIds.size > 1 ? "move" : "pointer" }}
                    />
                    <text
                      x={zone.svgX + zone.svgWidth / 2}
                      y={zone.svgY + zone.svgHeight / 2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={
                        // Clamp to at least 1 screen-pixel so tiny zones don't
                        // render invisible 0 px text. If the zone is smaller
                        // than 3 screen pixels the text is hidden entirely.
                        Math.min(zone.svgWidth, zone.svgHeight) * 3 < 3 / tf.s
                          ? 0
                          : Math.max(Math.min(zone.svgWidth, zone.svgHeight) * 0.18, 1 / tf.s)
                      }
                      fill={sel ? "#f59e0b" : "#000"}
                      stroke="#fff"
                      strokeWidth={3 / tf.s}
                      paintOrder="stroke"
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {sectionNumToDisplay(zone.sectionNum)}
                    </text>

                    {/* Corner handles (single-selected zone only) */}
                    {showHandles && (
                      <>
                        {/* Edge handles rendered first (lower SVG paint order = below corners).
                            Corners are rendered after so they sit on top and win click events
                            on small zones where edge and corner handles overlap. */}
                        {([
                          { h: "n" as Handle, cx: zone.svgX + zone.svgWidth / 2, cy: zone.svgY,                  w: hs * 2.5, ht: hs },
                          { h: "s" as Handle, cx: zone.svgX + zone.svgWidth / 2, cy: zone.svgY + zone.svgHeight, w: hs * 2.5, ht: hs },
                          { h: "e" as Handle, cx: zone.svgX + zone.svgWidth,     cy: zone.svgY + zone.svgHeight / 2, w: hs, ht: hs * 2.5 },
                          { h: "w" as Handle, cx: zone.svgX,                     cy: zone.svgY + zone.svgHeight / 2, w: hs, ht: hs * 2.5 },
                        ]).map(({ h, cx, cy, w, ht }) => (
                          <rect
                            key={h}
                            x={cx - w / 2}
                            y={cy - ht / 2}
                            width={w}
                            height={ht}
                            fill="#f59e0b"
                            stroke="#000"
                            strokeWidth={1.5 / tf.s}
                            onMouseDown={(e) => onHandleMouseDown(e, zone, h)}
                            style={{ cursor: HANDLE_CURSOR[h] }}
                          />
                        ))}
                        {/* Corner handles — rendered last so they paint on top */}
                        {(["nw", "ne", "sw", "se"] as Handle[]).map((h) => {
                          const hx = h.includes("e")
                            ? zone.svgX + zone.svgWidth
                            : zone.svgX;
                          const hy = h.includes("s")
                            ? zone.svgY + zone.svgHeight
                            : zone.svgY;
                          return (
                            <rect
                              key={h}
                              x={hx - hs / 2}
                              y={hy - hs / 2}
                              width={hs}
                              height={hs}
                              fill="#f59e0b"
                              stroke="#000"
                              strokeWidth={1.5 / tf.s}
                              onMouseDown={(e) => onHandleMouseDown(e, zone, h)}
                              style={{ cursor: HANDLE_CURSOR[h] }}
                            />
                          );
                        })}
                      </>
                    )}
                  </g>
                );
              })}

              {/* All overlay rects are rendered inside the align <g> because their
                  coordinates are in zone space (raw svgX/svgY), matching the zones
                  in this same group. strokeWidth is divided by align.s so strokes
                  appear at the same screen thickness regardless of calibration scale. */}

              {/* Live drawing preview (draw mode — amber dashed) */}
              {draftRect && draftRect.w > 0 && draftRect.h > 0 && (
                <rect
                  x={draftRect.x}
                  y={draftRect.y}
                  width={draftRect.w}
                  height={draftRect.h}
                  fill="rgba(234,179,8,0.12)"
                  stroke="#eab308"
                  strokeWidth={sw / align.s}
                  strokeDasharray={`${14 / tf.s / align.s} ${7 / tf.s / align.s}`}
                  style={{ pointerEvents: "none" }}
                />
              )}

              {/* Fill flash (300 ms feedback after fill click — blue) */}
              {fillFlashRect && fillFlashRect.w > 0 && fillFlashRect.h > 0 && (
                <rect
                  x={fillFlashRect.x}
                  y={fillFlashRect.y}
                  width={fillFlashRect.w}
                  height={fillFlashRect.h}
                  fill="rgba(0,112,255,0.15)"
                  stroke="#0070ff"
                  strokeWidth={sw / align.s}
                  strokeDasharray={`${14 / tf.s / align.s} ${7 / tf.s / align.s}`}
                  style={{ pointerEvents: "none" }}
                />
              )}

              {/* Pending rect (drawn, awaiting form submission — blue) */}
              {pendingRect && (
                <rect
                  x={pendingRect.x}
                  y={pendingRect.y}
                  width={pendingRect.w}
                  height={pendingRect.h}
                  fill="rgba(0,112,255,0.15)"
                  stroke="#0070ff"
                  strokeWidth={sw / align.s}
                  strokeDasharray={`${14 / tf.s / align.s} ${7 / tf.s / align.s}`}
                  style={{ pointerEvents: "none" }}
                />
              )}

              {/* Rubber-band selection rectangle (Shift+drag) */}
              {rubberRect && rubberRect.w > 0 && rubberRect.h > 0 && (
                <rect
                  x={rubberRect.x}
                  y={rubberRect.y}
                  width={rubberRect.w}
                  height={rubberRect.h}
                  fill="rgba(59,130,246,0.08)"
                  stroke="#3b82f6"
                  strokeWidth={sw / align.s}
                  strokeDasharray={`${10 / tf.s / align.s} ${5 / tf.s / align.s}`}
                  style={{ pointerEvents: "none" }}
                />
              )}
              </g>
            </g>
          </svg>

          {loading && (
            <div style={styles.loadingBadge}>Loading zones…</div>
          )}
        </div>

        {/* ── Sidebar ───────────────────────────────────────────────────────── */}
        <div style={styles.sidebar}>
          {/* Context-sensitive form area */}
          <SideSection style={{ flex: "0 1 auto", overflowY: "auto", minHeight: 0 }}>
            <button
              onClick={() => setZoneEditOpen((o) => !o)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                margin: 0,
                marginBottom: zoneEditOpen ? 10 : 0,
              }}
            >
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.06em",
                color: "#374151",
                textTransform: "uppercase" as const,
              }}>
                Zone Edit
              </span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>
                {zoneEditOpen ? "▲" : "▼"}
              </span>
            </button>
            {zoneEditOpen && (isMulti ? (
              <>
                <div style={styles.formTitle}>{selectedIds.size} zones selected</div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10, lineHeight: 1.4 }}>
                  Edit shared properties below. Changes save automatically when you click away.
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      void handleMultiAutoSave();
                    }
                  }}
                >
                  <div>
                    <Label>Aisle ID — all selected</Label>
                    <input
                      value={multiAisleId}
                      onChange={(e) => setMultiAisleId(e.target.value.toUpperCase())}
                      onBlur={(e) => setMultiAisleId(formatTwoDigit(e.target.value))}
                      placeholder={multiAisleIds.size > 1 ? "— mixed —" : "e.g. 09"}
                      style={styles.input}
                    />
                    {multiAisleIds.size > 1 && (
                      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
                        Mixed: {[...multiAisleIds].join(", ")}
                      </div>
                    )}
                  </div>
                  <div>
                    <Label>Section # — all selected</Label>
                    <input
                      value={multiSectionNum}
                      onChange={(e) => setMultiSectionNum(e.target.value.toUpperCase())}
                      placeholder={multiSectionNums.size > 1 ? "— mixed —" : "e.g. 06 or A"}
                      style={styles.input}
                    />
                    {multiSectionNums.size > 1 && (
                      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
                        Mixed: {[...multiSectionNums].map((n) => sectionNumToDisplay(n)).join(", ")}
                      </div>
                    )}
                  </div>
                </div>
                <Row style={{ flexWrap: "wrap" }}>
                  <Btn
                    color="#3b82f6"
                    disabled={
                      multiSaving ||
                      (!multiAisleId.trim() && !multiSectionNum.trim()) ||
                      (!!multiAisleId.trim() && !isValidAisleId(multiAisleId))
                    }
                    onClick={() => {
                      if (multiAisleId.trim() && !isValidAisleId(multiAisleId)) {
                        toast.error("Aisle ID must be numeric (e.g. 09)");
                        return;
                      }
                      const updates: Partial<Zone> = {};
                      if (multiAisleId.trim()) updates.aisleId = normalizeAisleId(multiAisleId.trim());
                      if (multiSectionNum.trim()) {
                        const parsed = parseSectionInput(multiSectionNum.trim());
                        if (parsed !== null) updates.sectionNum = parsed;
                      }
                      if (Object.keys(updates).length === 0) return;
                      void handleMultiSave(updates);
                    }}
                  >
                    {multiSaving ? "Saving…" : `Save ${selectedIds.size} zones`}
                  </Btn>
                  <Btn
                    color="#0070ff"
                    disabled={saving}
                    onClick={() => void handleMultiDuplicate()}
                  >
                    {saving ? "Duplicating…" : `Duplicate ${selectedIds.size}`}
                  </Btn>
                  <Btn color="#6b7280" onClick={() => { setSelectedIds(new Set()); setSelectionOrder([]); }}>
                    Clear
                  </Btn>
                </Row>
              </>
            ) : (pendingRect || selectedZone || mode === "draw") ? (
              <>
                <div style={styles.formTitle}>
                  {selectedZone && !pendingRect ? `Zone #${selectedZone.id}` : "New Zone"}
                </div>
                {pendingRect && (
                  <div style={styles.coordInfo}>
                    {pendingRect.x.toFixed(0)},{pendingRect.y.toFixed(0)} ·{" "}
                    {pendingRect.w.toFixed(0)}×{pendingRect.h.toFixed(0)}
                  </div>
                )}
                {selectedZone && !pendingRect && (
                  <div style={styles.coordInfo}>
                    {selectedZone.svgX.toFixed(1)},{selectedZone.svgY.toFixed(1)}{" "}
                    · {selectedZone.svgWidth.toFixed(1)}×
                    {selectedZone.svgHeight.toFixed(1)}
                  </div>
                )}
                <div
                  onBlur={(e) => {
                    if (pendingRect) return;
                    // Capture zone id synchronously — React batches the concurrent
                    // mousedown state update until after blur fires, so selectedId
                    // is still the previous zone's id here. Capturing it explicitly
                    // makes the intent clear and robust.
                    const zoneIdToSave = selectedId;
                    if (!zoneIdToSave) return;
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      const committedForm = zoneFormRef.current?.getCommittedForm() ?? formRef.current;
                      void flushSave(committedForm, zoneIdToSave);
                    }
                  }}
                >
                  {draftOffer && draftOffer.zoneId === selectedId && (
                    <div style={styles.draftRestoreBanner}>
                      <div style={styles.draftRestoreText}>
                        ↩ Unsaved edits from{" "}
                        {new Date(draftOffer.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
                        — server was unreachable when auto-save fired.
                      </div>
                      <div style={styles.draftRestoreActions}>
                        <button
                          style={styles.draftRestoreBtn}
                          onClick={() => {
                            setForm(draftOffer.form);
                            clearDraft(draftOffer.zoneId);
                            setDraftOffer(null);
                          }}
                        >
                          Restore
                        </button>
                        <button
                          style={styles.draftDiscardBtn}
                          onClick={() => {
                            clearDraft(draftOffer.zoneId);
                            setDraftOffer(null);
                          }}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}
                  <ZoneForm
                    ref={zoneFormRef}
                    key={selectedZone?.id ?? "pending"}
                    form={form}
                    onChange={setForm}
                    aisleIdError={aisleIdError}
                  />
                  {duplicateConflict && (pendingRect || selectedZone) && (
                    <div style={styles.dupWarning}>
                      ⚠ Section {sectionNumToDisplay(duplicateConflict.sectionNum)} already exists. Saving
                      anyway will create an overlapping mapping.
                    </div>
                  )}
                  {pendingRect && (
                    <Row>
                      <Btn color="#3b82f6" onClick={handleCreate} disabled={saving || !!aisleIdError}>
                        {saving ? "Saving…" : "Save Zone"}
                      </Btn>
                      <Btn
                        color="#6b7280"
                        onClick={() => {
                          setPendingRect(null);
                          setDraftRect(null);
                        }}
                      >
                        Cancel
                      </Btn>
                    </Row>
                  )}
                  {selectedZone && !pendingRect && (
                    <Row style={{ flexWrap: "wrap" }}>
                      <Btn
                        color="#0070ff"
                        onClick={handleDuplicate}
                        disabled={saving}
                      >
                        Duplicate
                      </Btn>
                      <Btn
                        color="#7c3aed"
                        onClick={copyCoords}
                      >
                        Copy coords
                      </Btn>
                      <Btn
                        color="#6b7280"
                        onClick={() => { setSelectedIds(new Set()); setSelectionOrder([]); }}
                      >
                        Deselect
                      </Btn>
                      <Btn
                        color="#dc2626"
                        onClick={handleDelete}
                        disabled={saving}
                      >
                        Delete
                      </Btn>
                    </Row>
                  )}
                </div>
                {!pendingRect && !selectedZone && mode === "draw" && (
                  <div style={styles.emptyHint}>
                    Click and drag on the map to draw a new zone.
                  </div>
                )}
              </>
            ) : (
              <div style={styles.emptyHint}>
                {mode === "fill"
                  ? fillLoading
                    ? "Detecting zone bounds…"
                    : "Click inside any enclosed white area on the floor plan to auto-detect its bounding rectangle."
                  : "Click a zone to select it. Shift+click to multi-select. Shift+drag background for rubber-band select."}
              </div>
            ))}
          </SideSection>

          {/* ── Auto-number sections panel ─────────────────────────────────── */}
          {zones.length > 0 && (
            <SideSection style={{ flex: "none" }}>
              <button
                onClick={() => setAutoNumOpen((o) => !o)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  margin: 0,
                }}
              >
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: "#7c3aed",
                  textTransform: "uppercase" as const,
                }}>
                  ⚡ Auto-number sections
                </span>
                <span style={{ fontSize: 11, color: "#9ca3af" }}>
                  {autoNumOpen ? "▲" : "▼"}
                </span>
              </button>

              {autoNumOpen && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  {/* Starting number */}
                  <div>
                    <Label>Starting number</Label>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      {(["0", "1", "2", "custom"] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setAutoNumStartMode(mode)}
                          style={{
                            padding: "3px 8px",
                            fontSize: 11,
                            fontWeight: autoNumStartMode === mode ? 700 : 400,
                            border: "1px solid",
                            borderColor: autoNumStartMode === mode ? "#7c3aed" : "#d1d5db",
                            borderRadius: 4,
                            background: autoNumStartMode === mode ? "#ede9fe" : "#fff",
                            color: autoNumStartMode === mode ? "#7c3aed" : "#374151",
                            cursor: "pointer",
                          }}
                        >
                          {mode === "0" ? "00 (even)" : mode === "1" ? "1 (odd)" : mode === "2" ? "2 (even)" : "Custom"}
                        </button>
                      ))}
                    </div>
                    {autoNumStartMode === "custom" && (
                      <input
                        type="text"
                        value={autoNumStartCustom}
                        onChange={(e) => setAutoNumStartCustom(e.target.value)}
                        placeholder="e.g. 01 or 001"
                        style={{ ...styles.input, width: 90, marginTop: 6 }}
                      />
                    )}
                  </div>

                  {/* Increment */}
                  <div>
                    <Label>Increment (default 2)</Label>
                    <input
                      type="number"
                      value={autoNumIncrement}
                      min={1}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v) && v >= 1) setAutoNumIncrement(v);
                      }}
                      style={{ ...styles.input, width: 70 }}
                    />
                  </div>

                  {/* Preview list */}
                  {autoNumPreview.length > 0 && (
                    <div>
                      <Label>Preview — {autoNumPreview.length} zone{autoNumPreview.length !== 1 ? "s" : ""}</Label>
                      <div style={{
                        maxHeight: 130,
                        overflowY: "auto",
                        border: "1px solid #e5e7eb",
                        borderRadius: 4,
                        background: "#fff",
                        fontSize: 11,
                        fontFamily: "monospace",
                      }}>
                        {autoNumPreview.map(({ zone, newSectionNumDisplay }) => (
                          <div
                            key={zone.id}
                            style={{
                              padding: "3px 8px",
                              borderBottom: "1px solid #f3f4f6",
                              display: "flex",
                              justifyContent: "flex-start",
                              gap: 6,
                              color: "#374151",
                            }}
                          >
                            <span style={{ color: "#6b7280" }}>
                              Zone #{zone.id} ({sectionNumToDisplay(zone.sectionNum)} →)
                            </span>
                            <span style={{ fontWeight: 600, color: "#7c3aed" }}>
                              {newSectionNumDisplay}
                            </span>
                          </div>
                        ))}
                      </div>
                      {/* Cross-aisle warning */}
                      {new Set(autoNumPreview.map((p) => normalizeAisleId(p.zone.aisleId))).size > 1 && (
                        <div style={{
                          marginTop: 6,
                          background: "#fffbeb",
                          border: "1px solid #fbbf24",
                          borderRadius: 4,
                          padding: "5px 8px",
                          fontSize: 11,
                          color: "#92400e",
                        }}>
                          ⚠ Zones span {new Set(autoNumPreview.map((p) => normalizeAisleId(p.zone.aisleId))).size} aisles — numbering will be assigned across all selected aisles.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Sync sort order checkbox */}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={autoNumSyncSortOrder}
                      onChange={(e) => setAutoNumSyncSortOrder(e.target.checked)}
                      style={{ cursor: "pointer", accentColor: "#7c3aed" }}
                    />
                    <span style={{ fontSize: 11, color: "#374151" }}>
                      Sync sidebar sort order to match section numbers
                    </span>
                  </label>

                  {selectedIds.size === 0 && (
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>
                      Select zones on the map to auto-number them.
                    </div>
                  )}

                  {/* Live collision warning */}
                  {liveCollisions.length > 0 && (
                    <div style={{
                      background: "#fef2f2",
                      border: "1px solid #fca5a5",
                      borderRadius: 4,
                      padding: "6px 8px",
                      fontSize: 11,
                      color: "#991b1b",
                    }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        ⛔ Collision with {liveCollisions.length} non-selected zone{liveCollisions.length !== 1 ? "s" : ""}
                      </div>
                      {liveCollisions.map((c, i) => (
                        <div key={i} style={{ marginTop: 2 }}>
                          Aisle {c.aisleId}: §{c.sectionNum} is held by the zone currently at §{c.blockingSectionNum}
                        </div>
                      ))}
                      <div style={{ marginTop: 5, color: "#7f1d1d" }}>
                        Select the blocking zone(s) too, or choose a different starting number.
                      </div>
                    </div>
                  )}

                  {/* Apply button */}
                  <Btn
                    color="#7c3aed"
                    disabled={autoNumApplying || autoNumPreview.length === 0}
                    onClick={() => void handleAutoNumber()}
                  >
                    {autoNumApplying
                      ? "Applying…"
                      : autoNumPreview.length > 0
                        ? `Apply to ${autoNumPreview.length} zone${autoNumPreview.length !== 1 ? "s" : ""} (undoable)`
                        : "Apply"}
                  </Btn>
                </div>
              )}
            </SideSection>
          )}

          {/* Zone list */}
          <div style={styles.zoneList}>
            <button
              onClick={() => setZoneListOpen((o) => !o)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "2px 12px 8px",
                margin: 0,
              }}
            >
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase" as const,
                color: "#6b7280",
              }}>
                {zones.length} zone{zones.length !== 1 ? "s" : ""}
                {selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
                {loading && " · loading…"}
              </span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>
                {zoneListOpen ? "▲" : "▼"}
              </span>
            </button>
            {zoneListOpen && (<>
            {coverage && (coverage.unsortedCount > 0 || coverage.uncoveredAisles.length > 0) && (
              <div style={styles.coverageBanner}>
                {coverage.unsortedCount > 0 && (
                  <div>
                    ⚠ {coverage.unsortedCount} item{coverage.unsortedCount !== 1 ? "s" : ""} with no valid bin location
                  </div>
                )}
                {coverage.uncoveredAisles.length > 0 && (
                  <div>
                    ⚠ {coverage.uncoveredAisles.length} aisle{coverage.uncoveredAisles.length !== 1 ? "s" : ""} in inventory with no zone: {coverage.uncoveredAisles.join(", ")}
                  </div>
                )}
              </div>
            )}
            {loadError && (
              <div style={styles.errorMsg}>{loadError}</div>
            )}
            {displayZones.map((zone) => {
              const sel = selectedIds.has(zone.id);
              return (
                <div
                  key={zone.id}
                  data-zone-id={zone.id}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      // Shift+click: toggle in multi-selection
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(zone.id)) next.delete(zone.id);
                        else next.add(zone.id);
                        return next;
                      });
                      setSelectionOrder((prev) => {
                        if (prev.includes(zone.id)) return prev.filter((id) => id !== zone.id);
                        return [...prev, zone.id];
                      });
                    } else {
                      setSelectedIds(new Set([zone.id]));
                      setSelectionOrder([zone.id]);
                    }
                    setPendingRect(null);
                  }}
                  style={{
                    ...styles.zoneItem,
                    borderLeft: sel ? "3px solid #f59e0b" : "3px solid transparent",
                    background: sel ? "rgba(245,158,11,0.08)" : "transparent",
                  }}
                >
                  <div style={styles.zoneItemLabel}>Aisle {zone.aisleId} §{sectionNumToDisplay(zone.sectionNum)}</div>
                  <div style={styles.zoneItemMeta}>
                    {zone.isInventory ? "inventory" : "non-inv"}
                  </div>
                </div>
              );
            })}
            {!loading && zones.length === 0 && !loadError && (
              <div style={styles.emptyList}>
                No zones yet. Switch to Draw mode and drag on the map.
              </div>
            )}
            </>)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

export type ZoneFormHandle = {
  /** Returns the current form values with any pending rawSection input committed. */
  getCommittedForm: () => FormState;
};

type ZoneFormProps = {
  form: FormState;
  onChange: (f: FormState) => void;
  aisleIdError?: string | null;
};

export const ZoneForm = forwardRef<ZoneFormHandle, ZoneFormProps>(function ZoneForm({
  form,
  onChange,
  aisleIdError,
}, ref) {
  // Local raw string for the Section # field while the user is typing.
  // null = field is not focused (show the canonical formatted value).
  // This prevents the cursor jumping to position 0 when typing "15" — without
  // local state, every keystroke re-formats via sectionNumToDisplay and
  // React replaces the entire value, resetting the cursor.
  const [rawSection, setRawSection] = useState<string | null>(null);

  // Expose committed form values to parent (captures rawSection before blur fires).
  useImperativeHandle(ref, () => ({
    getCommittedForm: () => {
      if (rawSection === null) return form;
      const parsed = parseSectionInput(rawSection);
      return { ...form, sectionNum: parsed ?? null };
    },
  }), [form, rawSection]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div>
        <Label>Aisle ID</Label>
        <input
          value={form.aisleId}
          onChange={(e) =>
            onChange({
              ...form,
              aisleId: e.target.value.toUpperCase(),
            })
          }
          onBlur={(e) =>
            onChange({
              ...form,
              aisleId: formatTwoDigit(e.target.value),
            })
          }
          placeholder="e.g. 09 or 22"
          style={{
            ...styles.input,
            borderColor: aisleIdError ? "#f87171" : undefined,
          }}
        />
        {aisleIdError && (
          <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>
            {aisleIdError}
          </div>
        )}
      </div>
      <div>
        <Label>Section #</Label>
        <input
          value={rawSection !== null ? rawSection : sectionNumToDisplay(form.sectionNum)}
          onFocus={() => setRawSection(sectionNumToDisplay(form.sectionNum))}
          onChange={(e) => {
            const raw = e.target.value.toUpperCase();
            setRawSection(raw);
          }}
          onBlur={() => {
            const parsed = parseSectionInput(rawSection ?? "");
            onChange({ ...form, sectionNum: parsed ?? null });
            setRawSection(null);
          }}
          placeholder="e.g. 06 or A"
          style={styles.input}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          id="isInv"
          checked={form.isInventory}
          onChange={(e) => onChange({ ...form, isInventory: e.target.checked })}
          style={{ width: 14, height: 14 }}
        />
        <label
          htmlFor="isInv"
          style={{ fontSize: 12, color: "#6b7280", cursor: "pointer" }}
        >
          Inventory zone (interactive in mobile app)
        </label>
      </div>
    </div>
  );
});

function SideSection({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        padding: "12px",
        borderBottom: "1px solid #2a2a2a",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.06em",
        color: "#9ca3af",
        textTransform: "uppercase",
        marginBottom: 3,
      }}
    >
      {children}
    </div>
  );
}

function Row({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        marginTop: 10,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Btn({
  children,
  color,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  color: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px",
        borderRadius: 4,
        background: disabled ? "#374151" : color,
        color: "white",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 12,
        fontWeight: 500,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function ModeBtn({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "3px 12px",
        borderRadius: 4,
        background: active ? "white" : "transparent",
        color: active ? "#7c3aed" : "rgba(255,255,255,0.85)",
        border: "1px solid rgba(255,255,255,0.5)",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  root: {
    display: "flex",
    flexDirection: "column" as const,
    position: "fixed" as const,
    inset: 0,
    overflow: "hidden",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: "#fff",
    color: "#111",
  },
  banner: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "6px 16px",
    background: "#7c3aed",
    color: "white",
    fontSize: 12,
    flexShrink: 0,
    zIndex: 10,
  },
  backLink: {
    color: "rgba(255,255,255,0.85)",
    textDecoration: "none",
    fontSize: 12,
    fontWeight: 500,
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid rgba(255,255,255,0.3)",
    whiteSpace: "nowrap" as const,
    marginRight: 4,
  },
  modeBar: {
    display: "flex",
    gap: 6,
    marginLeft: "auto",
  },
  hint: {
    fontSize: 11,
    opacity: 0.75,
    marginLeft: 8,
  },
  content: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
    minHeight: 0,
  },
  canvas: {
    flex: 1,
    position: "relative" as const,
    overflow: "hidden",
    background: "#fff",
  },
  svg: {
    position: "absolute" as const,
    inset: 0,
    width: "100%",
    height: "100%",
    display: "block",
    overflow: "hidden",
  } as React.CSSProperties,
  loadingBadge: {
    position: "absolute" as const,
    bottom: 12,
    left: 12,
    background: "rgba(0,0,0,0.75)",
    color: "white",
    fontSize: 12,
    padding: "5px 12px",
    borderRadius: 6,
    pointerEvents: "none" as const,
  },
  sidebar: {
    width: 288,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column" as const,
    borderLeft: "1px solid #e0e0e0",
    background: "#fafafa",
    overflow: "hidden",
    position: "relative" as const,
    zIndex: 1,
  },
  input: {
    width: "100%",
    background: "#fff",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    color: "#111",
    padding: "5px 8px",
    fontSize: 12,
    boxSizing: "border-box" as const,
    outline: "none",
  } as React.CSSProperties,
  formTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 8,
  },
  coordInfo: {
    fontSize: 11,
    color: "#6b7280",
    marginBottom: 8,
    fontFamily: "monospace",
  },
  emptyHint: {
    fontSize: 12,
    color: "#6b7280",
    lineHeight: 1.5,
  },
  zoneList: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "8px 0",
  },
  listHeader: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    color: "#6b7280",
    padding: "2px 12px 8px",
  },
  errorMsg: {
    padding: "6px 12px",
    color: "#f87171",
    fontSize: 12,
  },
  zoneItem: {
    padding: "7px 12px",
    cursor: "pointer",
    borderLeft: "3px solid transparent",
    transition: "background 0.1s",
  },
  zoneItemLabel: {
    fontSize: 13,
    fontWeight: 500,
    color: "#111",
  },
  zoneItemMeta: {
    fontSize: 11,
    color: "#9ca3af",
    marginTop: 1,
  },
  emptyList: {
    padding: "16px 12px",
    color: "#6b7280",
    fontSize: 12,
    textAlign: "center" as const,
    lineHeight: 1.6,
  },
  dupWarning: {
    margin: "8px 0 4px",
    padding: "6px 8px",
    background: "rgba(234,179,8,0.12)",
    border: "1px solid rgba(234,179,8,0.4)",
    borderRadius: 4,
    fontSize: 11,
    color: "#92400e",
    lineHeight: 1.5,
  },
  coverageBanner: {
    margin: "0 8px 6px",
    padding: "6px 8px",
    background: "rgba(239,68,68,0.08)",
    border: "1px solid rgba(239,68,68,0.25)",
    borderRadius: 4,
    fontSize: 11,
    color: "#991b1b",
    lineHeight: 1.6,
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  draftRestoreBanner: {
    margin: "0 0 8px",
    padding: "8px 10px",
    background: "rgba(245,158,11,0.10)",
    border: "1px solid rgba(245,158,11,0.40)",
    borderRadius: 4,
    fontSize: 11,
    color: "#78350f",
    lineHeight: 1.5,
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
  draftRestoreText: {
    lineHeight: 1.5,
  },
  draftRestoreActions: {
    display: "flex",
    gap: 6,
  },
  draftRestoreBtn: {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    background: "rgba(245,158,11,0.18)",
    border: "1px solid rgba(245,158,11,0.50)",
    borderRadius: 3,
    cursor: "pointer",
    color: "#78350f",
  },
  draftDiscardBtn: {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    background: "transparent",
    border: "1px solid rgba(180,150,100,0.35)",
    borderRadius: 3,
    cursor: "pointer",
    color: "#92400e",
  },
};
