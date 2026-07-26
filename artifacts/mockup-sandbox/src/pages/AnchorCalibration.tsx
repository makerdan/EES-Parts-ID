/**
 * Anchor Calibration — DEV-ONLY internal admin tool for placing up to 3 named
 * anchor points on the warehouse floor-plan SVG. Each anchor maps an SVG click
 * coordinate to a zone-data (world) coordinate. Mirrors the mobile app's
 * Admin → Anchor-Point Calibration screen; both read/write the same rows via
 * the admin map-anchors API.
 *
 * Interaction model:
 *   Pan   : drag background to pan, scroll wheel to zoom
 *   Place : press "Place" on a slot, then click the map to set its SVG point
 *   Save  : enter a name + world X/Y and press Save (PUT /admin/map-anchors/:slot)
 *   Clear : press Clear on a saved slot (DELETE /admin/map-anchors/:slot)
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import warehouseMapFallback from "../../public/warehouse-map.svg?raw";

function extractSvgInner(svgRaw: string): string {
  return svgRaw
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
}

const svgFallbackInner = extractSvgInner(warehouseMapFallback);
const INITIAL_SCALE = 0.18;
const API_BASE = `${window.location.origin}/api`;
const CLICK_SLOP_PX = 5; // max movement for a mousedown+up to count as a click

const ANCHOR_COLORS = ["#f59e0b", "#0ea5e9", "#10b981"] as const;

interface Transform {
  x: number;
  y: number;
  s: number;
}

export interface MapAnchor {
  id: number;
  name: string;
  svgX: number;
  svgY: number;
  worldX: number;
  worldY: number;
  updatedAt: string;
}

interface SlotForm {
  name: string;
  worldXStr: string;
  worldYStr: string;
}

function emptySlot(): SlotForm {
  return { name: "", worldXStr: "", worldYStr: "" };
}

function safeParseFloat(s: string): number | null {
  const n = parseFloat(s.trim());
  return isFinite(n) ? n : null;
}

function clampScale(s: number): number {
  return Math.max(0.05, Math.min(4, s));
}

type Coord = { x: number; y: number } | null;

export function AnchorCalibration() {
  const svgRef = useRef<SVGSVGElement>(null);
  const floorPlanRef = useRef<SVGGElement>(null);
  const [svgInner, setSvgInner] = useState<string>(svgFallbackInner);
  const [tf, setTf] = useState<Transform>({ x: 40, y: 40, s: INITIAL_SCALE });

  const [anchors, setAnchors] = useState<Array<MapAnchor>>([]);
  const [loadError, setLoadError] = useState("");
  const [forms, setForms] = useState<[SlotForm, SlotForm, SlotForm]>([
    emptySlot(),
    emptySlot(),
    emptySlot(),
  ]);
  const [svgCoords, setSvgCoords] = useState<[Coord, Coord, Coord]>([
    null,
    null,
    null,
  ]);
  const [pickingSlot, setPickingSlot] = useState<0 | 1 | 2 | null>(null);
  const [busy, setBusy] = useState<[boolean, boolean, boolean]>([
    false,
    false,
    false,
  ]);
  const [status, setStatus] = useState("");

  const panRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    moved: boolean;
    originTf: Transform;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    moved: false,
    originTf: { x: 40, y: 40, s: INITIAL_SCALE },
  });

  // ── Data loading ────────────────────────────────────────────────────────────

  // Latest uploaded floor plan (falls back to the bundled SVG on 404).
  useEffect(() => {
    void (async () => {
      const fallback = (
        import.meta.env.VITE_FLOOR_PLAN_API_FALLBACK as string | undefined
      )?.replace(/\/$/, "");
      const urls = [`${API_BASE}/floor-plan/svg`];
      if (fallback && fallback !== API_BASE)
        urls.push(`${fallback}/floor-plan/svg`);
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            setSvgInner(extractSvgInner(await res.text()));
            return;
          }
        } catch {
          /* try next */
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (floorPlanRef.current) {
      floorPlanRef.current.innerHTML = svgInner;
    }
  }, [svgInner]);

  const refetchAnchors = useCallback(async () => {
    try {
      // Clerk session cookie is sent automatically with same-origin requests.
      const res = await fetch(`${API_BASE}/admin/map-anchors`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { anchors: Array<MapAnchor> };
      setAnchors(data.anchors ?? []);
      setLoadError("");
    } catch {
      setLoadError("Failed to load anchors");
    }
  }, []);

  useEffect(() => {
    void refetchAnchors();
  }, [refetchAnchors]);

  // Sync forms + placed coordinates from the saved anchors.
  useEffect(() => {
    const nextForms: [SlotForm, SlotForm, SlotForm] = [
      emptySlot(),
      emptySlot(),
      emptySlot(),
    ];
    const nextCoords: [Coord, Coord, Coord] = [null, null, null];
    for (const a of anchors) {
      const idx = a.id - 1;
      if (idx >= 0 && idx <= 2) {
        nextForms[idx] = {
          name: a.name,
          worldXStr: String(a.worldX),
          worldYStr: String(a.worldY),
        };
        nextCoords[idx] = { x: a.svgX, y: a.svgY };
      }
    }
    setForms(nextForms);
    setSvgCoords(nextCoords);
  }, [anchors]);

  // ── Pan / zoom / click handling ─────────────────────────────────────────────

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      panRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        originTf: { ...tf },
      };
      e.preventDefault();
    },
    [tf],
  );

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!panRef.current.active) return;
    const dx = e.clientX - panRef.current.startX;
    const dy = e.clientY - panRef.current.startY;
    if (Math.abs(dx) > CLICK_SLOP_PX || Math.abs(dy) > CLICK_SLOP_PX) {
      panRef.current.moved = true;
    }
    setTf({
      ...panRef.current.originTf,
      x: panRef.current.originTf.x + dx,
      y: panRef.current.originTf.y + dy,
    });
  }, []);

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const wasClick = panRef.current.active && !panRef.current.moved;
      panRef.current.active = false;
      if (!wasClick || pickingSlot === null) return;

      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Screen → SVG viewBox coordinates (invert translate+scale transform).
      const svgX = (e.clientX - rect.left - tf.x) / tf.s;
      const svgY = (e.clientY - rect.top - tf.y) / tf.s;
      const slot = pickingSlot;
      setSvgCoords((prev) => {
        const next = [...prev] as typeof prev;
        next[slot] = { x: svgX, y: svgY };
        return next;
      });
      setPickingSlot(null);
    },
    [pickingSlot, tf],
  );

  const onMouseLeave = useCallback(() => {
    panRef.current.active = false;
  }, []);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setTf((prev) => {
      const newS = clampScale(prev.s * factor);
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return prev;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      return {
        s: newS,
        x: cx - (cx - prev.x) * (newS / prev.s),
        y: cy - (cy - prev.y) * (newS / prev.s),
      };
    });
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // ── Save / clear ────────────────────────────────────────────────────────────

  const setSlotBusy = useCallback((idx: number, value: boolean) => {
    setBusy((prev) => {
      const next = [...prev] as typeof prev;
      next[idx] = value;
      return next;
    });
  }, []);

  const handleSave = useCallback(
    async (idx: 0 | 1 | 2) => {
      const coord = svgCoords[idx];
      const form = forms[idx];
      const wx = safeParseFloat(form.worldXStr);
      const wy = safeParseFloat(form.worldYStr);

      if (!coord) {
        setStatus(`Anchor ${idx + 1}: place a point on the map first.`);
        return;
      }
      if (wx === null || wy === null) {
        setStatus(`Anchor ${idx + 1}: enter valid world X and Y coordinates.`);
        return;
      }

      setSlotBusy(idx, true);
      setStatus("");
      try {
        const res = await fetch(`${API_BASE}/admin/map-anchors/${idx + 1}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            svgX: coord.x,
            svgY: coord.y,
            worldX: wx,
            worldY: wy,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await refetchAnchors();
        setStatus(`Anchor ${idx + 1} saved.`);
      } catch {
        setStatus(`Anchor ${idx + 1}: save failed. Please try again.`);
      } finally {
        setSlotBusy(idx, false);
      }
    },
    [svgCoords, forms, refetchAnchors, setSlotBusy],
  );

  const handleClear = useCallback(
    async (idx: 0 | 1 | 2) => {
      if (
        !window.confirm(
          `Clear Anchor ${idx + 1}? This removes the anchor point; with fewer than 3 anchors the mobile overlay reverts to ZoneAlignment sliders.`,
        )
      ) {
        return;
      }
      setSlotBusy(idx, true);
      setStatus("");
      try {
        const res = await fetch(`${API_BASE}/admin/map-anchors/${idx + 1}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await refetchAnchors();
        setStatus(`Anchor ${idx + 1} cleared.`);
      } catch {
        setStatus(`Anchor ${idx + 1}: clear failed. Please try again.`);
      } finally {
        setSlotBusy(idx, false);
      }
    },
    [refetchAnchors, setSlotBusy],
  );

  const isSaved = useCallback(
    (idx: number) => anchors.some((a) => a.id === idx + 1),
    [anchors],
  );

  const updateForm = useCallback(
    (idx: 0 | 1 | 2, patch: Partial<SlotForm>) => {
      setForms((prev) => {
        const next = [...prev] as typeof prev;
        next[idx] = { ...next[idx], ...patch };
        return next;
      });
    },
    [],
  );

  // Marker radius that stays visually consistent regardless of zoom.
  const markerR = useMemo(() => 14 / tf.s, [tf.s]);

  return (
    <div style={styles.root}>
      {/* ── Banner ──────────────────────────────────────────────────────────── */}
      <div style={styles.banner}>
        <a href="/__mockup" style={styles.backLink}>← Internal Tools</a>
        <span style={{ fontWeight: 600 }}>
          ⚠ DEV TOOL — Anchor Calibration — internal use only
        </span>
        {loadError && <span style={styles.errorPill}>⚠ {loadError}</span>}
        <span style={styles.hint}>
          {anchors.length}/3 saved · scroll to zoom · drag to pan ·{" "}
          {(tf.s * 100).toFixed(0)}%
        </span>
      </div>

      <div style={styles.body}>
        {/* ── Sidebar ─────────────────────────────────────────────────────── */}
        <div style={styles.sidebar}>
          <p style={styles.infoText}>
            Place 3 anchor points to enable full affine calibration
            (translation, scale, rotation, shear) in the mobile app. With fewer
            than 3, the ZoneAlignment sliders are used unchanged.
          </p>

          {([0, 1, 2] as const).map((idx) => {
            const color = ANCHOR_COLORS[idx];
            const coord = svgCoords[idx];
            const form = forms[idx];
            const saved = isSaved(idx);
            const isBusy = busy[idx];
            const isPicking = pickingSlot === idx;

            return (
              <div
                key={idx}
                style={{
                  ...styles.slotCard,
                  borderColor: isPicking ? color : saved ? color + "80" : "#ddd",
                }}
              >
                <div style={styles.slotHeader}>
                  <span style={{ ...styles.slotBadge, background: color }}>
                    {idx + 1}
                  </span>
                  <span style={styles.slotTitle}>
                    Anchor {idx + 1}
                    {saved && (
                      <span style={{ color, fontWeight: 600 }}> ✓ saved</span>
                    )}
                  </span>
                </div>

                <div style={styles.coordRow}>
                  <div style={{ flex: 1 }}>
                    <div style={styles.fieldLabel}>Floor plan point</div>
                    <div style={{ fontSize: 12, color: coord ? "#111" : "#999" }}>
                      {coord
                        ? `x: ${coord.x.toFixed(1)},  y: ${coord.y.toFixed(1)}`
                        : "Not placed"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPickingSlot(isPicking ? null : idx)}
                    style={{
                      ...styles.placeBtn,
                      background: isPicking ? color : color + "18",
                      color: isPicking ? "#fff" : color,
                      borderColor: color,
                    }}
                  >
                    {isPicking ? "Cancel" : coord ? "Re-place" : "Place"}
                  </button>
                </div>

                <div style={styles.fieldLabel}>Landmark name</div>
                <input
                  style={styles.input}
                  value={form.name}
                  onChange={(e) => updateForm(idx, { name: e.target.value })}
                  placeholder="e.g. Entrance corner"
                />

                <div style={styles.worldRow}>
                  <div style={{ flex: 1 }}>
                    <div style={styles.fieldLabel}>World X</div>
                    <input
                      style={styles.input}
                      value={form.worldXStr}
                      onChange={(e) =>
                        updateForm(idx, { worldXStr: e.target.value })
                      }
                      placeholder="0"
                      inputMode="decimal"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={styles.fieldLabel}>World Y</div>
                    <input
                      style={styles.input}
                      value={form.worldYStr}
                      onChange={(e) =>
                        updateForm(idx, { worldYStr: e.target.value })
                      }
                      placeholder="0"
                      inputMode="decimal"
                    />
                  </div>
                </div>

                <div style={styles.actionRow}>
                  <button
                    type="button"
                    onClick={() => void handleSave(idx)}
                    disabled={isBusy}
                    style={{
                      ...styles.saveBtn,
                      opacity: isBusy ? 0.6 : 1,
                    }}
                  >
                    {isBusy ? "Working…" : saved ? "Update" : "Save"}
                  </button>
                  {saved && (
                    <button
                      type="button"
                      onClick={() => void handleClear(idx)}
                      disabled={isBusy}
                      style={{
                        ...styles.clearBtn,
                        opacity: isBusy ? 0.6 : 1,
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {status && <div style={styles.statusText}>{status}</div>}
        </div>

        {/* ── SVG canvas ──────────────────────────────────────────────────── */}
        <div style={styles.canvasWrap}>
          {pickingSlot !== null && (
            <div
              style={{
                ...styles.pickBanner,
                background: ANCHOR_COLORS[pickingSlot] + "cc",
              }}
            >
              Click the map to place Anchor {pickingSlot + 1}
            </div>
          )}
          <svg
            ref={svgRef}
            style={{
              ...styles.svg,
              cursor:
                pickingSlot !== null
                  ? "crosshair"
                  : panRef.current.active
                    ? "grabbing"
                    : "grab",
            }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
          >
            <g transform={`translate(${tf.x},${tf.y}) scale(${tf.s})`}>
              <g ref={floorPlanRef} pointerEvents="none" />

              {/* Anchor markers */}
              {([0, 1, 2] as const).map((idx) => {
                const coord = svgCoords[idx];
                if (!coord) return null;
                const color = ANCHOR_COLORS[idx];
                return (
                  <g key={idx} pointerEvents="none">
                    <circle
                      cx={coord.x}
                      cy={coord.y}
                      r={markerR * 1.4}
                      fill={color + "30"}
                      stroke={color}
                      strokeWidth={markerR * 0.25}
                    />
                    <circle
                      cx={coord.x}
                      cy={coord.y}
                      r={markerR * 0.5}
                      fill={color}
                    />
                    <text
                      x={coord.x + markerR * 1.6}
                      y={coord.y - markerR * 0.3}
                      fontSize={markerR * 1.2}
                      fill={color}
                      fontWeight="bold"
                      style={{ userSelect: "none" }}
                    >
                      {idx + 1}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  root: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100vh",
    overflow: "hidden",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
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
  errorPill: {
    background: "rgba(255,100,0,0.25)",
    padding: "1px 8px",
    borderRadius: 4,
    fontSize: 11,
    whiteSpace: "nowrap" as const,
  },
  hint: {
    marginLeft: "auto",
    opacity: 0.7,
    whiteSpace: "nowrap" as const,
  },
  body: {
    display: "flex",
    flex: 1,
    minHeight: 0,
  },
  sidebar: {
    width: 320,
    flexShrink: 0,
    overflowY: "auto" as const,
    padding: 14,
    borderRight: "1px solid #e5e5e5",
    background: "#fafafa",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  },
  infoText: {
    fontSize: 12,
    color: "#666",
    lineHeight: 1.5,
    margin: 0,
    padding: "8px 10px",
    background: "#f0f0f0",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
  },
  slotCard: {
    border: "1.5px solid #ddd",
    borderRadius: 10,
    padding: 12,
    background: "#fff",
  },
  slotHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  slotBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    color: "#fff",
    fontSize: 12,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  slotTitle: {
    fontSize: 13,
    fontWeight: 600,
  },
  coordRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  placeBtn: {
    fontSize: 12,
    fontWeight: 600,
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid",
    cursor: "pointer",
  },
  fieldLabel: {
    fontSize: 10,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    color: "#888",
    marginBottom: 3,
  },
  input: {
    width: "100%",
    boxSizing: "border-box" as const,
    fontSize: 13,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #ccc",
    marginBottom: 8,
    background: "#fff",
    color: "#111",
  },
  worldRow: {
    display: "flex",
    gap: 8,
  },
  actionRow: {
    display: "flex",
    gap: 8,
    marginTop: 4,
  },
  saveBtn: {
    flex: 1,
    fontSize: 12,
    fontWeight: 600,
    padding: "7px 0",
    borderRadius: 6,
    border: "none",
    background: "#0070ff",
    color: "#fff",
    cursor: "pointer",
  },
  clearBtn: {
    fontSize: 12,
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: 6,
    border: "1px solid #e11d48",
    background: "#fff",
    color: "#e11d48",
    cursor: "pointer",
  },
  statusText: {
    fontSize: 12,
    color: "#444",
    padding: "6px 10px",
    background: "#eef4ff",
    border: "1px solid #d0e0ff",
    borderRadius: 6,
  },
  canvasWrap: {
    position: "relative" as const,
    flex: 1,
    minWidth: 0,
    display: "flex",
  },
  pickBanner: {
    position: "absolute" as const,
    top: 10,
    left: "50%",
    transform: "translateX(-50%)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 16px",
    borderRadius: 8,
    zIndex: 5,
    pointerEvents: "none" as const,
  },
  svg: {
    flex: 1,
    width: "100%",
    display: "block",
    background: "#f8f8f8",
    userSelect: "none" as const,
  },
};
