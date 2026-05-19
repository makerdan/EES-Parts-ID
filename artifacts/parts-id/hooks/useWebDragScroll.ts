import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import type { ScrollView } from "react-native";

type ScrollableNode = { getScrollableNode: () => HTMLElement | undefined };

interface DragState {
  active: boolean;
  startX: number;
  startScrollLeft: number;
}

/**
 * Web-only: adds click-and-drag horizontal scrolling to the given ScrollView
 * ref. No-ops on iOS / Android.
 */
export function useWebDragScroll(ref: React.RefObject<ScrollView | null>) {
  const drag = useRef<DragState>({ active: false, startX: 0, startScrollLeft: 0 });

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = (ref.current as unknown as ScrollableNode | null)
      ?.getScrollableNode?.();
    if (!node) return;

    const state = drag.current;

    function onMouseDown(e: MouseEvent) {
      state.active = true;
      state.startX = e.pageX - node!.offsetLeft;
      state.startScrollLeft = node!.scrollLeft;
      node!.style.cursor = "grabbing";
      node!.style.userSelect = "none";
    }

    function onMouseMove(e: MouseEvent) {
      if (!state.active) return;
      e.preventDefault();
      const x = e.pageX - node!.offsetLeft;
      node!.scrollLeft = state.startScrollLeft - (x - state.startX);
    }

    function onRelease() {
      if (!state.active) return;
      state.active = false;
      node!.style.cursor = "";
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
    };
  });
}
