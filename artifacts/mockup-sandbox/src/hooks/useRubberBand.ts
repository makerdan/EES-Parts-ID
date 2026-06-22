/**
 * useRubberBand.ts
 *
 * Encapsulates the rubber-band (Shift+drag) selection gesture for the Zone
 * Editor SVG canvas.
 *
 * Lifecycle:
 *   1. Caller passes the handler returned by the hook to the SVG's onMouseDown.
 *   2. When the user presses Shift and starts dragging, the hook adds
 *      document-level mousemove / mouseup listeners.
 *   3. On mouseup the listeners are removed, the selection is committed, and
 *      the visual rubber-rect is cleared.
 *   4. On unmount any active drag is cancelled cleanly (no lingering listeners,
 *      no "update on unmounted component" warning).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { normRect, hitTestZones, type ZoneRect } from "../utils/rubberBandSelect";
import type { Tf } from "../utils/wheelZoom";

/** Minimum screen-pixel size that qualifies as a real drag (not a stray click). */
const MIN_RUBBER_PX = 8;

/** Internal drag state captured at mousedown. */
interface RubberDrag {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  shift: boolean;
}

/** Zone must have at least id + AABB geometry. */
type RubberZone = ZoneRect & { id: number };

interface UseRubberBandOptions<T extends RubberZone> {
  /** Live ref to the current zone list — read at drag-end for hit-testing. */
  zonesRef: React.RefObject<T[]>;
  /** Live ref to the current SVG transform — used to compute minPx in SVG units. */
  tfRef: React.RefObject<Tf>;
  /** Converts screen client coordinates to SVG user-unit coordinates. */
  getSvgPt: (clientX: number, clientY: number) => { x: number; y: number };
  /** Current selection set (accepted to match the intended hook API; functional
   *  updates via setSelectedIds do not require reading this directly). */
  selectedIds: Set<number>;
  /** React state setter for the multi-select set. */
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<number>>>;
  /** Clears the pending (drawn-but-unsaved) rect on a plain rubber-band select. */
  setPendingRect: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; w: number; h: number } | null>
  >;
}

interface UseRubberBandResult {
  /** The live selection rectangle in SVG units, or null when no drag is active. */
  rubberRect: { x: number; y: number; w: number; h: number } | null;
  /**
   * Bind this to the SVG element's onMouseDown.
   * The handler only activates on left-button Shift+click; all other mousedowns
   * are ignored so the caller can handle pan / draw / fill itself.
   */
  onSvgMouseDown: (e: React.MouseEvent<SVGSVGElement>) => void;
}

export function useRubberBand<T extends RubberZone>({
  zonesRef,
  tfRef,
  getSvgPt,
  setSelectedIds,
  setPendingRect,
}: UseRubberBandOptions<T>): UseRubberBandResult {
  const [rubberRect, setRubberRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  /** Mutable drag state — updated on every mousemove. */
  const dragRef = useRef<RubberDrag | null>(null);

  /**
   * Cleanup fn that removes the current document listeners.
   * Stored in a ref so the unmount effect and double-mousedown guard can call it.
   */
  const cleanupRef = useRef<(() => void) | null>(null);

  /** Stable refs to the latest setter callbacks — avoids stale closure captures. */
  const setSelectedIdsRef = useRef(setSelectedIds);
  const setPendingRectRef = useRef(setPendingRect);
  useEffect(() => {
    setSelectedIdsRef.current = setSelectedIds;
  }, [setSelectedIds]);
  useEffect(() => {
    setPendingRectRef.current = setPendingRect;
  }, [setPendingRect]);

  /** Remove document listeners and reset all drag state. */
  const teardown = useCallback((clearRect = true) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    dragRef.current = null;
    if (clearRect) setRubberRect(null);
  }, []);

  /** Clean up on unmount (covers the "unmount mid-drag" scenario). */
  useEffect(() => {
    return () => {
      teardown(false);
    };
  }, [teardown]);

  const onSvgMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (e.button !== 0 || !e.shiftKey) return;

      e.preventDefault();

      // If a previous drag is still live (double-mousedown), cancel it first.
      teardown(true);

      const p = getSvgPt(e.clientX, e.clientY);
      dragRef.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y, shift: true };

      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const p2 = getSvgPt(ev.clientX, ev.clientY);
        dragRef.current = { ...drag, x2: p2.x, y2: p2.y };
        const r = normRect(drag.x1, drag.y1, p2.x, p2.y);
        setRubberRect({ x: r.svgX, y: r.svgY, w: r.svgWidth, h: r.svgHeight });
      };

      const onUp = () => {
        const drag = dragRef.current;

        // Remove listeners before any state update (prevents double-fire).
        cleanupRef.current?.();
        cleanupRef.current = null;
        dragRef.current = null;
        setRubberRect(null);

        if (!drag) return;

        const scale = tfRef.current?.s ?? 1;
        const minSvg = MIN_RUBBER_PX / scale;
        const r = normRect(drag.x1, drag.y1, drag.x2, drag.y2);
        const zones = zonesRef.current ?? [];
        const hits = hitTestZones(zones, r, minSvg);

        if (hits.length > 0) {
          // Design decision: Shift is an ADDITIVE modifier.
          // The rubber-band result is unioned with the existing selection so
          // that dragging over a second group never silently discards the first.
          // This matches the UX convention in Figma, Illustrator, etc.
          // Consequence: to deselect zones the user must click on empty canvas
          // (the plain-click handler already handles that path).
          const newIds = hits.map((z) => z.id);
          setSelectedIdsRef.current((prev) => new Set([...prev, ...newIds]));
          setPendingRectRef.current(null);
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      cleanupRef.current = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
    },
    [getSvgPt, zonesRef, tfRef, teardown],
  );

  return { rubberRect, onSvgMouseDown };
}
