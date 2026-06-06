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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Toaster, toast } from "sonner";
import { computeWheelZoom } from "../utils/wheelZoom";
import { deriveParity } from "../utils/deriveParity";
import { isValidAisleId, findDuplicateConflict, normalizeAisleId } from "@workspace/zone-validation";
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
    if (a < 128) return true; // transparent pixels treated as white background
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

// Maps the user-facing Fill sensitivity setting to a luminance threshold.
// "Light" pixels (lum >= darkThreshold) are treated as walkable space.
//   Low  → 100 — lets colored areas (lum 100-180) pass as walkable; good for color-coded maps
//   Medium → 160 — balanced; works for lightly tinted or greyscale maps
//   High → 200 — only near-white pixels are walkable; best for standard B&W maps
const FILL_SENSITIVITY_THRESHOLD: Record<"low" | "medium" | "high", number> = {
  low: 100,
  medium: 160,
  high: 200,
};
const MIN_ZONE_PX = 8; // minimum zone size in screen pixels before it's discarded
const API_BASE = `${window.location.origin}/api`;
const INITIAL_SCALE = 0.18; // start zoomed out to show whole floor plan

// ── Types ─────────────────────────────────────────────────────────────────────
interface Zone {
  id: number;
  aisleId: string;
  label: string;
  sectionParity: "all" | "odd" | "even";
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
type Mode = "pan" | "draw" | "fill";

export interface FormState {
  aisleId: string;
  label: string;
  sectionParity: "all" | "odd" | "even";
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
  | { t: "fillPending"; sx: number; sy: number };

// ── Helpers ───────────────────────────────────────────────────────────────────

function screenToSvg(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  tf: Tf,
): Pt {
  return {
    x: (clientX - rect.left - tf.x) / tf.s,
    y: (clientY - rect.top - tf.y) / tf.s,
  };
}

function normRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { svgX: number; svgY: number; svgWidth: number; svgHeight: number } {
  return {
    svgX: Math.min(x1, x2),
    svgY: Math.min(y1, y2),
    svgWidth: Math.abs(x2 - x1),
    svgHeight: Math.abs(y2 - y1),
  };
}

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

// ── Main Component ────────────────────────────────────────────────────────────
export function ZoneEditor() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Floor plan SVG: starts with bundled fallback, then replaced by latest upload.
  const [svgInner, setSvgInner] = useState<string>(svgFallbackInner);
  // Natural coordinate dimensions of the floor plan SVG (for rasterizer mapping).
  const [svgDims, setSvgDims] = useState<{ w: number; h: number }>(svgFallbackDims);
  const [tf, setTf] = useState<Tf>({ x: 0, y: 0, s: INITIAL_SCALE });
  const [mode, setMode] = useState<Mode>("pan");
  // True while the async rasterize+fill operation is in progress.
  const [fillLoading, setFillLoading] = useState(false);
  // Fill sensitivity: persisted to localStorage so it survives page reload.
  const [fillSensitivity, setFillSensitivity] = useState<"low" | "medium" | "high">(() => {
    try {
      const stored = localStorage.getItem("zoneEditorFillSensitivity");
      if (stored === "low" || stored === "medium" || stored === "high") return stored;
    } catch {}
    return "high";
  });

  // Multi-select: a Set of selected zone IDs
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // draftRect: the live rectangle being drawn (while dragging in draw mode)
  const [draftRect, setDraftRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);
  // pendingRect: drawn but not yet saved (shows in sidebar form)
  const [pendingRect, setPendingRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);
  // rubberRect: live selection rectangle (Shift+drag in pan mode)
  const [rubberRect, setRubberRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);
  // dragZone: live zone position during move/resize (single-select)
  const [dragZone, setDragZone] = useState<Zone | null>(null);
  // multiDragDelta: live offset applied to all selected zones during multi-move
  const [multiDragDelta, setMultiDragDelta] = useState<Pt | null>(null);
  // Original positions of every selected zone at the start of a multi-move drag
  const multiDragOriginsRef = useRef<Map<number, Pt>>(new Map());
  const [form, setForm] = useState<FormState>({
    aisleId: "", label: "", sectionParity: "all", isInventory: true, sortOrder: 0,
  });
  const parityOverrideRef = useRef(false);
  const [saving, setSaving] = useState(false);

  // Multi-select form fields
  const [multiAisleId, setMultiAisleId] = useState("");
  const [multiParity, setMultiParity] = useState<"" | "all" | "odd" | "even">("");
  const [multiSaving, setMultiSaving] = useState(false);
  // Track last-saved values so blur auto-save can diff against them
  const lastMultiAisleIdRef = useRef("");
  const lastMultiParityRef = useRef<"" | "all" | "odd" | "even">("");
  const [coverage, setCoverage] = useState<{
    unsortedCount: number;
    uncoveredAisles: string[];
  } | null>(null);

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

  useEffect(() => { tfRef.current = tf; }, [tf]);
  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { dragZoneRef.current = dragZone; }, [dragZone]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { svgInnerRef.current = svgInner; }, [svgInner]);
  useEffect(() => { svgDimsRef.current = svgDims; }, [svgDims]);
  useEffect(() => { fillLoadingRef.current = fillLoading; }, [fillLoading]);
  useEffect(() => {
    fillSensitivityRef.current = fillSensitivity;
    try { localStorage.setItem("zoneEditorFillSensitivity", fillSensitivity); } catch {}
  }, [fillSensitivity]);

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
    return isValidAisleId(form.aisleId) ? null : "Aisle ID must be a number (e.g. 12)";
  }, [form.aisleId]);

  // Tracks the form values as they were when last loaded from the server (used to
  // suppress false conflict warnings when a zone is selected but not yet changed).
  const lastSavedFormRef = useRef<FormState | null>(null);
  const prevSelectedIdRef = useRef<number | null>(null);

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
      form.sectionParity === lastSavedFormRef.current?.sectionParity
    ) {
      return null;
    }
    return findDuplicateConflict(zones, selectedId, form.aisleId, form.sectionParity);
  }, [zones, form.aisleId, form.sectionParity, selectedId]);

  // ── API helpers ─────────────────────────────────────────────────────────────
  const headers = useCallback(
    (): Record<string, string> => ({ "Content-Type": "application/json" }),
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

  // ── Keyboard delete shortcut ─────────────────────────────────────────────
  // Delete or Backspace removes all selected zones, unless focus is in a text field.
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
      setSaving(true);
      try {
        await Promise.all(
          ids.map((id) =>
            fetch(`${API_BASE}/warehouse-zones/${id}`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
            }).then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
            }),
          ),
        );
        toast.success(
          ids.length === 1 ? "Zone deleted" : `${ids.length} zones deleted`,
        );
        setSelectedIds(new Set());
        await fetchZones();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fetchZones]);

  const patchZone = useCallback(
    async (id: number, updates: Partial<Zone>): Promise<boolean> => {
      const res = await fetch(`${API_BASE}/warehouse-zones/${id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return true;
    },
    [headers],
  );

  // ── Form actions ────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!pendingRect) return;
    if (!form.aisleId.trim()) { toast.error("Aisle ID is required"); return; }
    if (!isValidAisleId(form.aisleId)) { toast.error("Aisle ID must be numeric (e.g. 12)"); return; }
    const label = form.label.trim() || form.aisleId.trim();
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/warehouse-zones`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          aisleId: form.aisleId.trim(),
          label,
          sectionParity: form.sectionParity,
          isInventory: form.isInventory,
          svgX: pendingRect.x,
          svgY: pendingRect.y,
          svgWidth: pendingRect.w,
          svgHeight: pendingRect.h,
          sortOrder: form.sortOrder,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { zone } = await res.json() as { zone: Zone };
      toast.success(`Zone "${zone.label}" created`);
      setPendingRect(null);
      setSelectedIds(new Set([zone.id]));
      parityOverrideRef.current = false;
      setForm({ aisleId: zone.aisleId, label: zone.label, sectionParity: zone.sectionParity, isInventory: zone.isInventory, sortOrder: zone.sortOrder });
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!selectedId) return;
    if (!form.aisleId.trim()) { toast.error("Aisle ID is required"); return; }
    if (!isValidAisleId(form.aisleId)) { toast.error("Aisle ID must be numeric (e.g. 12)"); return; }
    setSaving(true);
    try {
      await patchZone(selectedId, {
        aisleId: form.aisleId.trim(),
        label: form.label.trim() || form.aisleId.trim(),
        sectionParity: form.sectionParity,
        isInventory: form.isInventory,
        sortOrder: form.sortOrder,
      });
      toast.success("Zone updated");
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (!await showConfirm("Delete zone", "Delete this zone? This cannot be undone.", true)) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/warehouse-zones/${selectedId}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Zone deleted");
      setSelectedIds(new Set());
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
      const res = await fetch(`${API_BASE}/warehouse-zones`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          aisleId: form.aisleId.trim(),
          label: form.label.trim() || form.aisleId.trim(),
          sectionParity: form.sectionParity,
          isInventory: form.isInventory,
          svgX: selectedZone.svgX + selectedZone.svgWidth + 2,
          svgY: selectedZone.svgY,
          svgWidth: selectedZone.svgWidth,
          svgHeight: selectedZone.svgHeight,
          sortOrder: 0,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { zone } = await res.json() as { zone: Zone };
      toast.success(`Duplicated → placed to the right`);
      setSelectedIds(new Set([zone.id]));
      parityOverrideRef.current = false;
      setForm({ aisleId: zone.aisleId, label: zone.label, sectionParity: zone.sectionParity, isInventory: zone.isInventory, sortOrder: zone.sortOrder });
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
      const results = await Promise.all(
        selectedZoneList.map((z) =>
          fetch(`${API_BASE}/warehouse-zones`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({
              aisleId: z.aisleId,
              label: z.label,
              sectionParity: z.sectionParity,
              isInventory: z.isInventory,
              sortOrder: z.sortOrder,
              svgX: z.svgX,
              svgY: z.svgY + z.svgHeight + 4,
              svgWidth: z.svgWidth,
              svgHeight: z.svgHeight,
            }),
          }).then(async (res) => {
            if (!res.ok) {
              const err = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(err.error ?? `HTTP ${res.status}`);
            }
            return res.json() as Promise<{ zone: Zone }>;
          }),
        ),
      );
      const newIds = new Set(results.map((r) => r.zone.id));
      toast.success(`Duplicated ${newIds.size} zone${newIds.size !== 1 ? "s" : ""} — drag to reposition`);
      setSelectedIds(newIds);
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleMultiSave = async (updates: Partial<Zone>) => {
    const n = selectedIds.size;
    const parts: string[] = [];
    if (updates.aisleId) parts.push(`Aisle ID → ${updates.aisleId}`);
    if (updates.sectionParity) parts.push(`Section Parity → ${updates.sectionParity}`);
    const what = parts.length ? parts.join(", ") : "selected properties";
    if (!await showConfirm(`Update ${n} zone${n !== 1 ? "s" : ""}`, what)) return;
    setMultiSaving(true);
    try {
      await Promise.all([...selectedIds].map((id) => patchZone(id, updates)));
      if (updates.aisleId !== undefined) lastMultiAisleIdRef.current = updates.aisleId;
      if (updates.sectionParity !== undefined) lastMultiParityRef.current = updates.sectionParity as typeof multiParity;
      toast.success(`Updated ${n} zones`);
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setMultiSaving(false);
    }
  };

  // Auto-save multi-select aisle data on blur (no confirm dialog)
  const handleMultiAutoSave = async () => {
    if (multiSaving || selectedIds.size === 0) return;
    const updates: Partial<Zone> = {};
    const trimmedAisle = multiAisleId.trim();
    if (trimmedAisle && trimmedAisle !== lastMultiAisleIdRef.current) {
      if (!isValidAisleId(trimmedAisle)) return;
      updates.aisleId = trimmedAisle;
    }
    if (multiParity && multiParity !== lastMultiParityRef.current) {
      updates.sectionParity = multiParity;
    }
    if (Object.keys(updates).length === 0) return;
    setMultiSaving(true);
    try {
      await Promise.all([...selectedIds].map((id) => patchZone(id, updates)));
      if (updates.aisleId !== undefined) lastMultiAisleIdRef.current = updates.aisleId;
      if (updates.sectionParity !== undefined) lastMultiParityRef.current = updates.sectionParity as typeof multiParity;
      const n = selectedIds.size;
      toast.success(`Saved ${n} zone${n !== 1 ? "s" : ""}`);
      await fetchZones();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setMultiSaving(false);
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

  // Sync single-select form when selected zone changes
  useEffect(() => {
    if (!selectedId) return;
    const z = zones.find((z) => z.id === selectedId);
    if (z) {
      const synced: FormState = { aisleId: z.aisleId, label: z.label, sectionParity: z.sectionParity, isInventory: z.isInventory, sortOrder: z.sortOrder };
      // Only reset the manual-override flag when the selected zone actually changes,
      // not when the zones list refreshes for the same zone (e.g. after a save).
      if (selectedId !== prevSelectedIdRef.current) {
        parityOverrideRef.current = false;
      }
      prevSelectedIdRef.current = selectedId;
      setForm(synced);
      lastSavedFormRef.current = synced;
    }
  }, [selectedId, zones]);

  // Sync multi-select form fields when selection or zones change
  useEffect(() => {
    if (!isMulti) return;
    const list = zones.filter((z) => selectedIds.has(z.id));
    if (list.length === 0) return;
    const aisles = new Set(list.map((z) => z.aisleId));
    const parities = new Set(list.map((z) => z.sectionParity));
    const syncedAisle = aisles.size === 1 ? [...aisles][0]! : "";
    const syncedParity = parities.size === 1 ? [...parities][0]! as typeof multiParity : "";
    setMultiAisleId(syncedAisle);
    setMultiParity(syncedParity);
    lastMultiAisleIdRef.current = syncedAisle;
    lastMultiParityRef.current = syncedParity;
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
    autoSaveTimerRef.current = setTimeout(async () => {
      try {
        await patchZone(selectedId, {
          aisleId: form.aisleId.trim(),
          label: form.label.trim() || form.aisleId.trim(),
          sectionParity: form.sectionParity,
          isInventory: form.isInventory,
          sortOrder: form.sortOrder,
        });
        lastSavedFormRef.current = { ...form };
        toast.success("Saved");
        await fetchZones();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }, 600);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [form, selectedId, pendingRect]);

  // ── SVG coordinate utility ──────────────────────────────────────────────────
  const getSvgPt = useCallback((clientX: number, clientY: number): Pt => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    return screenToSvg(clientX, clientY, rect, tfRef.current);
  }, []);

  // ── Fill-mode click handler ─────────────────────────────────────────────────
  // Stable callback (reads from refs) — safe to call from any event handler.
  const handleFillClickRef = useRef<(clientX: number, clientY: number) => Promise<void>>(
    async () => { /* placeholder before first render */ }
  );

  const handleFillClick = useCallback(async (clientX: number, clientY: number) => {
    // Re-entrancy guard: ignore concurrent fill requests.
    if (fillLoadingRef.current) return;
    setFillLoading(true);
    try {
      const raster = await rasterizeSvg(svgInnerRef.current, svgDimsRef.current);
      const pt = getSvgPt(clientX, clientY);

      // Map SVG user-unit coordinates to raster pixel coordinates.
      const dims = svgDimsRef.current;
      const px = Math.round((pt.x / dims.w) * raster.w);
      const py = Math.round((pt.y / dims.h) * raster.h);

      const darkThreshold = FILL_SENSITIVITY_THRESHOLD[fillSensitivityRef.current];
      const bounds = floodFillBounds(raster.imageData, px, py, darkThreshold);
      if (!bounds) {
        toast.error("Click inside a light area, not on a wall or line.");
        return;
      }

      // Convert pixel bounding box back to SVG user units.
      const scaleX = dims.w / raster.w;
      const scaleY = dims.h / raster.h;
      const rect = {
        x: bounds.x * scaleX,
        y: bounds.y * scaleY,
        w: bounds.w * scaleX,
        h: bounds.h * scaleY,
      };

      // Flash the detected rectangle as a draftRect (~300 ms) for visual feedback.
      setDraftRect(rect);
      await new Promise<void>((r) => setTimeout(r, 300));
      setDraftRect(null);

      // Commit as pendingRect — opens the sidebar form (same flow as Draw mode).
      setPendingRect(rect);
      setSelectedIds(new Set());
      parityOverrideRef.current = false;
      setForm({ aisleId: "", label: "", sectionParity: "all", isInventory: true, sortOrder: 0 });

      // Auto-switch back to Pan so a stray click doesn't trigger another fill.
      setMode("pan");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Fill failed");
    } finally {
      setFillLoading(false);
    }
  }, [getSvgPt]);

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

      const p = getSvgPt(e.clientX, e.clientY);

      if (state.t === "draw") {
        ixRef.current = { ...state, x2: p.x, y2: p.y };
        const r = normRect(state.x1, state.y1, p.x, p.y);
        setDraftRect({ x: r.svgX, y: r.svgY, w: r.svgWidth, h: r.svgHeight });
        return;
      }

      if (state.t === "rubber") {
        ixRef.current = { ...state, x2: p.x, y2: p.y };
        const r = normRect(state.x1, state.y1, p.x, p.y);
        setRubberRect({ x: r.svgX, y: r.svgY, w: r.svgWidth, h: r.svgHeight });
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
          const r = normRect(state.ax, state.ay, p.x, p.y);
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
          setPendingRect(null);
        }
        return;
      }

      if (state.t === "draw") {
        const r = normRect(state.x1, state.y1, state.x2, state.y2);
        const minSvg = MIN_ZONE_PX / tfRef.current.s;
        setDraftRect(null);
        if (r.svgWidth < minSvg || r.svgHeight < minSvg) {
          setSelectedIds(new Set());
          setPendingRect(null);
          return;
        }
        setPendingRect({ x: r.svgX, y: r.svgY, w: r.svgWidth, h: r.svgHeight });
        setSelectedIds(new Set());
        parityOverrideRef.current = false;
        setForm({ aisleId: "", label: "", sectionParity: "all", isInventory: true, sortOrder: 0 });
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

      if (state.t === "rubber") {
        setRubberRect(null);
        const r = normRect(state.x1, state.y1, state.x2, state.y2);
        const minSvg = MIN_ZONE_PX / tfRef.current.s;
        if (r.svgWidth >= minSvg && r.svgHeight >= minSvg) {
          const hits = zonesRef.current.filter(
            (z) =>
              z.svgX < r.svgX + r.svgWidth &&
              z.svgX + z.svgWidth > r.svgX &&
              z.svgY < r.svgY + r.svgHeight &&
              z.svgY + z.svgHeight > r.svgY,
          );
          if (hits.length > 0) {
            if (state.shift) {
              setSelectedIds((prev) => new Set([...prev, ...hits.map((z) => z.id)]));
            } else {
              setSelectedIds(new Set(hits.map((z) => z.id)));
            }
            setPendingRect(null);
          }
        }
        return;
      }

      if ((state.t === "move" || state.t === "resize") && dragZoneRef.current) {
        const zone = dragZoneRef.current;
        try {
          if (state.t === "move") {
            await patchZone(zone.id, { svgX: zone.svgX, svgY: zone.svgY });
            toast.success("Position saved");
          } else {
            await patchZone(zone.id, { svgX: zone.svgX, svgY: zone.svgY, svgWidth: zone.svgWidth, svgHeight: zone.svgHeight });
            toast.success("Size saved");
          }
          await fetch(`${API_BASE}/warehouse-zones`)
            .then((r) => r.json())
            .then((d) => {
              setZones(d.zones ?? []);
              setDragZone(null);
            });
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (state.t === "multiMove") {
        const origins = multiDragOriginsRef.current;
        // Only save if there was actual movement
        const dx = e.clientX;
        void dx; // used via getSvgPt below
        const currentDelta = (() => {
          if (!svgRef.current) return null;
          const rect = svgRef.current.getBoundingClientRect();
          const p = screenToSvg(e.clientX, e.clientY, rect, tfRef.current);
          return { x: p.x - state.startX, y: p.y - state.startY };
        })();
        setMultiDragDelta(null);
        if (!currentDelta || (Math.abs(currentDelta.x) < 0.5 && Math.abs(currentDelta.y) < 0.5)) return;
        try {
          await Promise.all(
            [...origins.entries()].map(([id, orig]) =>
              patchZone(id, { svgX: orig.x + currentDelta.x, svgY: orig.y + currentDelta.y }),
            ),
          );
          toast.success(`Moved ${origins.size} zone${origins.size !== 1 ? "s" : ""}`);
          await fetch(`${API_BASE}/warehouse-zones`)
            .then((r) => r.json())
            .then((d) => { setZones(d.zones ?? []); });
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
          await fetch(`${API_BASE}/warehouse-zones`)
            .then((r) => r.json())
            .then((d) => { setZones(d.zones ?? []); });
        }
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
  }, [getSvgPt, patchZone]);

  // ── React event handlers (attached to SVG element) ──────────────────────────
  const onSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (modeRef.current === "pan") {
      if (e.shiftKey) {
        // Shift+drag → rubber-band selection
        const p = getSvgPt(e.clientX, e.clientY);
        ixRef.current = { t: "rubber", x1: p.x, y1: p.y, x2: p.x, y2: p.y, shift: true };
        setRubberRect(null);
      } else {
        ixRef.current = {
          t: "pan",
          sx: e.clientX, sy: e.clientY,
          tx: tfRef.current.x, ty: tfRef.current.y,
        };
      }
    } else if (modeRef.current === "fill") {
      // Cancel any existing pending zone first (consistent with draw mode).
      setPendingRect(null);
      setDraftRect(null);
      // Record screen position; the actual fill fires on mouseup if movement < 5px.
      // This prevents accidental fills when the user was just trying to pan.
      ixRef.current = { t: "fillPending", sx: e.clientX, sy: e.clientY };
    } else {
      const p = getSvgPt(e.clientX, e.clientY);
      ixRef.current = { t: "draw", x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 });
      setPendingRect(null);
    }
  };

  const onZoneMouseDown = (e: React.MouseEvent, zone: Zone) => {
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

  // Mixed-value indicators for multi-select form
  const multiAisleIds = useMemo(
    () => new Set(selectedZoneList.map((z) => z.aisleId)),
    [selectedZoneList],
  );
  const multiParities = useMemo(
    () => new Set(selectedZoneList.map((z) => z.sectionParity)),
    [selectedZoneList],
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
          <ModeBtn active={mode === "draw"} onClick={() => { setMode("draw"); setSelectedIds(new Set()); setPendingRect(null); }}>
            Draw Zone
          </ModeBtn>
          <ModeBtn active={mode === "fill"} onClick={() => { setMode("fill"); setSelectedIds(new Set()); setPendingRect(null); }}>
            ⬛ Fill
          </ModeBtn>
        </div>
        {mode === "fill" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
            <label style={{ fontSize: 12, color: "#aaa", whiteSpace: "nowrap" }}>Fill sensitivity:</label>
            <select
              value={fillSensitivity}
              onChange={(e) => setFillSensitivity(e.target.value as "low" | "medium" | "high")}
              style={{
                fontSize: 12,
                background: "#222",
                color: "#eee",
                border: "1px solid #555",
                borderRadius: 4,
                padding: "2px 6px",
                cursor: "pointer",
              }}
            >
              <option value="low">Low — color maps</option>
              <option value="medium">Medium</option>
              <option value="high">High — B&W maps</option>
            </select>
          </div>
        )}
        <span style={styles.hint}>
          scroll-zoom · {mode === "pan"
            ? "drag to pan · Shift+drag to select · Shift+click to multi-select · drag selected to move all"
            : mode === "fill"
              ? "click inside an enclosed area to auto-detect its bounds"
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
                  : mode === "fill"
                    ? "crosshair"
                    : "crosshair",
            }}
            onMouseDown={onSvgMouseDown}
          >
            <g transform={`translate(${tf.x},${tf.y}) scale(${tf.s})`}>
              {/* Floor plan — embedded as a child <g> inside the SVG so it
                  shares the same coordinate system as zone overlays and stays
                  perfectly crisp at any zoom level (no rasterisation). */}
              <g ref={floorPlanRef} pointerEvents="none" />

              {/* Zone overlays */}
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
                        Math.min(zone.svgWidth, zone.svgHeight) * 0.18
                      }
                      fill={sel ? "#f59e0b" : "#000"}
                      stroke="#fff"
                      strokeWidth={3 / tf.s}
                      paintOrder="stroke"
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {zone.label}
                    </text>

                    {/* Corner handles (single-selected zone only) */}
                    {showHandles && (
                      <>
                        {/* Corner handles */}
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
                        {/* Edge handles — wider/taller bars to distinguish from corners */}
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
                      </>
                    )}
                  </g>
                );
              })}

              {/* Live drawing preview */}
              {draftRect && draftRect.w > 0 && draftRect.h > 0 && (
                <rect
                  x={draftRect.x}
                  y={draftRect.y}
                  width={draftRect.w}
                  height={draftRect.h}
                  fill="rgba(234,179,8,0.12)"
                  stroke="#eab308"
                  strokeWidth={sw}
                  strokeDasharray={`${14 / tf.s} ${7 / tf.s}`}
                  style={{ pointerEvents: "none" }}
                />
              )}

              {/* Pending rect (drawn, awaiting form submission) */}
              {pendingRect && (
                <rect
                  x={pendingRect.x}
                  y={pendingRect.y}
                  width={pendingRect.w}
                  height={pendingRect.h}
                  fill="rgba(234,179,8,0.15)"
                  stroke="#eab308"
                  strokeWidth={sw}
                  strokeDasharray={`${14 / tf.s} ${7 / tf.s}`}
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
                  strokeWidth={sw}
                  strokeDasharray={`${10 / tf.s} ${5 / tf.s}`}
                  style={{ pointerEvents: "none" }}
                />
              )}
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
            {pendingRect ? (
              <>
                <div style={styles.formTitle}>New Zone</div>
                <div style={styles.coordInfo}>
                  {pendingRect.x.toFixed(0)},{pendingRect.y.toFixed(0)} ·{" "}
                  {pendingRect.w.toFixed(0)}×{pendingRect.h.toFixed(0)}
                </div>
                <ZoneForm form={form} onChange={setForm} aisleIdError={aisleIdError} parityOverride={parityOverrideRef} />
                {duplicateConflict && (
                  <div style={styles.dupWarning}>
                    ⚠ Zone "{duplicateConflict.label}" already uses aisle{" "}
                    {duplicateConflict.aisleId} ({duplicateConflict.sectionParity}). Saving
                    anyway will create an overlapping mapping.
                  </div>
                )}
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
              </>
            ) : isMulti ? (
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
                      onChange={(e) => setMultiAisleId(e.target.value)}
                      placeholder={multiAisleIds.size > 1 ? "— mixed —" : ""}
                      style={styles.input}
                    />
                    {multiAisleIds.size > 1 && (
                      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
                        Mixed: {[...multiAisleIds].join(", ")}
                      </div>
                    )}
                  </div>
                  <div>
                    <Label>Section Parity — all selected</Label>
                    <select
                      value={multiParity}
                      onChange={(e) => setMultiParity(e.target.value as typeof multiParity)}
                      style={styles.input}
                    >
                      <option value="">
                        {multiParities.size > 1 ? "— mixed —" : "— select —"}
                      </option>
                      <option value="all">All sections</option>
                      <option value="odd">Odd sections only</option>
                      <option value="even">Even sections only</option>
                    </select>
                    {multiParities.size > 1 && (
                      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
                        Mixed: {[...multiParities].join(", ")}
                      </div>
                    )}
                  </div>
                </div>
                <Row style={{ flexWrap: "wrap" }}>
                  <Btn
                    color="#3b82f6"
                    disabled={
                      multiSaving ||
                      (!multiAisleId.trim() && !multiParity) ||
                      (!!multiAisleId.trim() && !isValidAisleId(multiAisleId))
                    }
                    onClick={() => {
                      if (multiAisleId.trim() && !isValidAisleId(multiAisleId)) {
                        toast.error("Aisle ID must be numeric (e.g. 12)");
                        return;
                      }
                      const updates: Partial<Zone> = {};
                      if (multiAisleId.trim()) updates.aisleId = multiAisleId.trim();
                      if (multiParity) updates.sectionParity = multiParity;
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
                  <Btn color="#6b7280" onClick={() => setSelectedIds(new Set())}>
                    Clear
                  </Btn>
                </Row>
              </>
            ) : selectedZone ? (
              <>
                <div style={styles.formTitle}>Zone #{selectedZone.id}</div>
                <div style={styles.coordInfo}>
                  {selectedZone.svgX.toFixed(1)},{selectedZone.svgY.toFixed(1)}{" "}
                  · {selectedZone.svgWidth.toFixed(1)}×
                  {selectedZone.svgHeight.toFixed(1)}
                </div>
                <ZoneForm form={form} onChange={setForm} aisleIdError={aisleIdError} parityOverride={parityOverrideRef} />
                {duplicateConflict && (
                  <div style={styles.dupWarning}>
                    ⚠ Zone "{duplicateConflict.label}" already uses aisle{" "}
                    {duplicateConflict.aisleId} ({duplicateConflict.sectionParity}). Saving
                    anyway will create an overlapping mapping.
                  </div>
                )}
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
                    onClick={() => setSelectedIds(new Set())}
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
              </>
            ) : (
              <div style={styles.emptyHint}>
                {mode === "draw"
                  ? "Click and drag on the map to draw a new zone."
                  : mode === "fill"
                    ? fillLoading
                      ? "Detecting zone bounds…"
                      : "Click inside any enclosed white area on the floor plan to auto-detect its bounding rectangle."
                    : "Click a zone to select it. Shift+click to multi-select. Shift+drag background for rubber-band select."}
              </div>
            )}
          </SideSection>

          {/* Zone list */}
          <div style={styles.zoneList}>
            <div style={styles.listHeader}>
              {zones.length} zone{zones.length !== 1 ? "s" : ""}
              {selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
              {loading && " · loading…"}
            </div>
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
                  onClick={(e) => {
                    if (e.shiftKey) {
                      // Shift+click: toggle in multi-selection
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(zone.id)) next.delete(zone.id);
                        else next.add(zone.id);
                        return next;
                      });
                    } else {
                      setSelectedIds(new Set([zone.id]));
                    }
                    setPendingRect(null);
                  }}
                  style={{
                    ...styles.zoneItem,
                    borderLeft: sel ? "3px solid #f59e0b" : "3px solid transparent",
                    background: sel ? "rgba(245,158,11,0.08)" : "transparent",
                  }}
                >
                  <div style={styles.zoneItemLabel}>{zone.label}</div>
                  <div style={styles.zoneItemMeta}>
                    Aisle {zone.aisleId} · {zone.sectionParity}
                    {zone.isInventory ? "" : " · non-inv"}
                  </div>
                </div>
              );
            })}
            {!loading && zones.length === 0 && !loadError && (
              <div style={styles.emptyList}>
                No zones yet. Switch to Draw mode and drag on the map.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
export function ZoneForm({
  form,
  onChange,
  aisleIdError,
  parityOverride,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  aisleIdError?: string | null;
  parityOverride: React.MutableRefObject<boolean>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div>
        <Label>Aisle ID</Label>
        <input
          value={form.aisleId}
          onChange={(e) =>
            onChange({
              ...form,
              aisleId: e.target.value,
              label: form.label || e.target.value,
            })
          }
          placeholder="e.g. 12"
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
          value={form.label}
          onChange={(e) => {
            const label = e.target.value;
            const updated: FormState = { ...form, label };
            if (!parityOverride.current) {
              const derived = deriveParity(label);
              if (derived !== null) updated.sectionParity = derived;
            }
            onChange(updated);
          }}
          placeholder="e.g. 12A"
          style={styles.input}
        />
      </div>
      <div>
        <Label>
          Section Parity
          {!parityOverride.current && deriveParity(form.label) !== null && (
            <span
              data-testid="parity-auto-hint"
              style={{
                marginLeft: 5,
                fontSize: 9,
                fontStyle: "italic",
                fontWeight: 400,
                letterSpacing: "0.03em",
                opacity: 0.75,
                textTransform: "none",
              }}
            >
              (auto)
            </span>
          )}
        </Label>
        <select
          value={form.sectionParity}
          onChange={(e) => {
            parityOverride.current = true;
            onChange({
              ...form,
              sectionParity: e.target.value as FormState["sectionParity"],
            });
          }}
          style={styles.input}
        >
          <option value="all">All sections</option>
          <option value="odd">Odd sections only</option>
          <option value="even">Even sections only</option>
        </select>
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
}

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
};
