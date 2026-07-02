import { useEffect, useRef } from "react";
import type { FlatList, ScrollView } from "react-native";
import { Platform } from "react-native";

type ScrollableNode = { getScrollableNode: () => HTMLElement | undefined };

const DRAG_THRESHOLD_PX = 4;

interface DragState {
  active: boolean;
  moved: boolean;
  startX: number;
  startScrollLeft: number;
}

/**
 * Web-only: adds click-and-drag horizontal scrolling to the given ScrollView
 * ref. Only responds to the primary (left) mouse button. A small movement
 * threshold prevents accidental drags from interfering with clicks.
 * No-ops on iOS / Android.
 */
export function useWebDragScroll(ref: React.RefObject<ScrollView | FlatList | null>) {
  const drag = useRef<DragState>({
    active: false,
    moved: false,
    startX: 0,
    startScrollLeft: 0,
  });

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = (ref.current as unknown as ScrollableNode | null)
      ?.getScrollableNode?.();
    if (!node) return;

    const state = drag.current;

    node.style.cursor = "grab";

    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      state.active = true;
      state.moved = false;
      state.startX = e.pageX - node!.offsetLeft;
      state.startScrollLeft = node!.scrollLeft;
    }

    function onMouseMove(e: MouseEvent) {
      if (!state.active) return;
      const x = e.pageX - node!.offsetLeft;
      const delta = x - state.startX;
      if (!state.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      if (!state.moved) {
        state.moved = true;
        node!.style.cursor = "grabbing";
        node!.style.userSelect = "none";
      }
      e.preventDefault();
      node!.scrollLeft = state.startScrollLeft - delta;
    }

    function onRelease() {
      if (!state.active) return;
      state.active = false;
      state.moved = false;
      node!.style.cursor = "grab";
      node!.style.userSelect = "";
    }

    node.addEventListener("mousedown", onMouseDown);
    node.addEventListener("mousemove", onMouseMove);
    node.addEventListener("mouseup", onRelease);
    node.addEventListener("mouseleave", onRelease);

    return () => {
      node.removeEventListener("mousedown", onMouseDown);
      node.removeEventListener("mousemove", onMouseMove);
      node.removeEventListener("mouseup", onRelease);
      node.removeEventListener("mouseleave", onRelease);
      node.style.cursor = "";
    };
  }, [ref]);
}
