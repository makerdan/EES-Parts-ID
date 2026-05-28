/**
 * Warehouse Map Viewer — DEV-ONLY internal tool for viewing the warehouse
 * floor plan SVG. Read-only pan/zoom view with zone overlays; no editing.
 *
 * Interaction model:
 *   Pan  : drag background to pan, scroll wheel to zoom
 *   Zoom : mouse wheel or pinch gesture
 */
import React, {
  useCallback,
  useEffect,
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

interface Transform {
  x: number;
  y: number;
  s: number;
}

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

function clampScale(s: number): number {
  return Math.max(0.05, Math.min(4, s));
}

export function WarehouseMapViewer() {
  const svgRef = useRef<SVGSVGElement>(null);
  const floorPlanRef = useRef<SVGGElement>(null);
  // Floor plan SVG: starts with bundled fallback, then replaced by latest upload.
  const [svgInner, setSvgInner] = useState<string>(svgFallbackInner);
  const [tf, setTf] = useState<Transform>({
    x: 40,
    y: 40,
    s: INITIAL_SCALE,
  });
  const [zones, setZones] = useState<Zone[]>([]);
  const [zonesError, setZonesError] = useState(false);

  const panRef = useRef<{ active: boolean; startX: number; startY: number; originTf: Transform }>({
    active: false,
    startX: 0,
    startY: 0,
    originTf: { x: 40, y: 40, s: INITIAL_SCALE },
  });

  // Fetch the latest uploaded floor plan. Tries the local API first; if it
  // returns 404 (nothing uploaded in this env), falls back to the production
  // API defined by VITE_FLOOR_PLAN_API_FALLBACK.
  useEffect(() => {
    void (async () => {
      const fallback = (import.meta.env.VITE_FLOOR_PLAN_API_FALLBACK as string | undefined)?.replace(/\/$/, "");
      const urls = [`${API_BASE}/floor-plan/svg`];
      if (fallback && fallback !== API_BASE) urls.push(`${fallback}/floor-plan/svg`);
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            setSvgInner(extractSvgInner(await res.text()));
            return;
          }
        } catch {}
      }
    })();
  }, []);

  // Inject floor plan SVG into same coordinate space as zone overlays
  useEffect(() => {
    if (floorPlanRef.current) {
      floorPlanRef.current.innerHTML = svgInner;
    }
  }, [svgInner]);

  // Fetch zones from API on mount
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/warehouse-zones`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { zones?: Zone[] };
        setZones(data.zones ?? []);
      } catch {
        setZonesError(true);
      }
    })();
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    panRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originTf: { ...tf },
    };
    e.preventDefault();
  }, [tf]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!panRef.current.active) return;
    const dx = e.clientX - panRef.current.startX;
    const dy = e.clientY - panRef.current.startY;
    setTf({
      ...panRef.current.originTf,
      x: panRef.current.originTf.x + dx,
      y: panRef.current.originTf.y + dy,
    });
  }, []);

  const onMouseUp = useCallback(() => {
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

  // Stroke width that stays visually consistent regardless of zoom
  const sw = 2 / tf.s;

  return (
    <div style={styles.root}>
      {/* ── Banner ──────────────────────────────────────────────────────────── */}
      <div style={styles.banner}>
        <a href="/__mockup" style={styles.backLink}>← Internal Tools</a>
        <span style={{ fontWeight: 600 }}>
          ⚠ DEV TOOL — Warehouse Map Viewer — internal use only
        </span>
        {zonesError && (
          <span style={styles.zoneError}>
            ⚠ zones unavailable
          </span>
        )}
        <span style={styles.hint}>
          {zones.length > 0 ? `${zones.length} zone${zones.length === 1 ? "" : "s"} · ` : ""}
          scroll to zoom · drag to pan · {(tf.s * 100).toFixed(0)}%
        </span>
      </div>

      {/* ── SVG canvas ──────────────────────────────────────────────────────── */}
      <svg
        ref={svgRef}
        style={{ ...styles.svg, cursor: panRef.current.active ? "grabbing" : "grab" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <g transform={`translate(${tf.x},${tf.y}) scale(${tf.s})`}>
          {/* Floor plan embedded in the same coordinate space */}
          <g ref={floorPlanRef} pointerEvents="none" />

          {/* Zone overlays — read-only, no interaction */}
          {zones.map((zone) => {
            const fill = zone.isInventory
              ? "rgba(0, 112, 255, 0.12)"
              : "rgba(0, 112, 255, 0.05)";
            const fontSize = Math.min(zone.svgWidth, zone.svgHeight) * 0.18;
            return (
              <g key={zone.id} pointerEvents="none">
                <rect
                  x={zone.svgX}
                  y={zone.svgY}
                  width={zone.svgWidth}
                  height={zone.svgHeight}
                  fill={fill}
                  stroke="#0070ff"
                  strokeWidth={sw}
                  strokeDasharray={
                    zone.isInventory ? undefined : `${12 / tf.s} ${6 / tf.s}`
                  }
                />
                <text
                  x={zone.svgX + zone.svgWidth / 2}
                  y={zone.svgY + zone.svgHeight / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={fontSize}
                  fill="#0050cc"
                  stroke="#fff"
                  strokeWidth={3 / tf.s}
                  paintOrder="stroke"
                  style={{ userSelect: "none" }}
                >
                  {zone.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
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
  zoneError: {
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
  svg: {
    flex: 1,
    width: "100%",
    display: "block",
    background: "#f8f8f8",
    userSelect: "none" as const,
  },
};
