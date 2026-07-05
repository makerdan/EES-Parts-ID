import { useCallback, useRef, useState } from "react";

/**
 * Manages common stateful interactions shared by map views:
 *  - Step-based zoom (linear, clamped to min/max) — used by WarehouseMapWeb
 *  - Highlight-with-auto-expire timer — used by WarehouseMapWeb
 *
 * For Reanimated-backed native map views (WarehouseMapView), use the companion
 * useMapZoomSteps() which wraps discrete zoom-stop navigation around an
 * external applyZoom callback instead of owning the zoom state directly.
 */
export interface UseMapInteractionOptions {
  initialZoom?: number;
  minZoom: number;
  maxZoom: number;
  zoomStep: number;
  highlightDurationMs?: number;
}

export interface UseMapInteractionResult {
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
  highlightedId: number | null;
  flashHighlight: (id: number) => void;
  clearHighlight: () => void;
}

export function useMapInteraction({
  initialZoom,
  minZoom,
  maxZoom,
  zoomStep,
  highlightDurationMs = 2000,
}: UseMapInteractionOptions): UseMapInteractionResult {
  const [zoom, setZoom] = useState(initialZoom ?? minZoom);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const zoomIn = useCallback(() => {
    setZoom(z => Math.min(z + zoomStep, maxZoom));
  }, [zoomStep, maxZoom]);

  const zoomOut = useCallback(() => {
    setZoom(z => Math.max(z - zoomStep, minZoom));
  }, [zoomStep, minZoom]);

  const flashHighlight = useCallback((id: number) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setHighlightedId(id);
    timerRef.current = setTimeout(() => {
      setHighlightedId(null);
      timerRef.current = null;
    }, highlightDurationMs);
  }, [highlightDurationMs]);

  const clearHighlight = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHighlightedId(null);
  }, []);

  return {
    zoom,
    zoomIn,
    zoomOut,
    canZoomIn: zoom < maxZoom,
    canZoomOut: zoom > minZoom,
    highlightedId,
    flashHighlight,
    clearHighlight,
  };
}

/**
 * Encapsulates discrete zoom-stop navigation for Reanimated-backed map views
 * (WarehouseMapView). The caller provides the stop count, a callback to apply
 * zoom at a given stop index, and a function to read the current stop index
 * from animated state (e.g. `zoomStopForScale(scale.value)`).
 *
 * Returns stable stepIn / stepOut callbacks that drive zoom buttons without
 * duplicating the clamp arithmetic in the component body.
 */
export function useMapZoomSteps(
  stopCount: number,
  applyZoomAtStop: (stopIndex: number) => void,
  currentStopFn: () => number,
): { stepIn: () => void; stepOut: () => void } {
  const stepIn = useCallback(() => {
    const next = Math.min(stopCount - 1, currentStopFn() + 1);
    applyZoomAtStop(next);
  }, [stopCount, applyZoomAtStop, currentStopFn]);

  const stepOut = useCallback(() => {
    const prev = Math.max(0, currentStopFn() - 1);
    applyZoomAtStop(prev);
  }, [applyZoomAtStop, currentStopFn]);

  return { stepIn, stepOut };
}
