import { useEffect } from "react";
import type { ScrollView } from "react-native";
import { Platform } from "react-native";

type ScrollableNode = { getScrollableNode: () => HTMLElement | undefined };

/**
 * Web-only: translates the mouse wheel's vertical delta into horizontal scroll
 * on the given ScrollView ref. No-ops on iOS / Android.
 */
export function useWebHorizontalScroll(
  ref: React.RefObject<ScrollView | null>,
) {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = (ref.current as unknown as ScrollableNode | null)
      ?.getScrollableNode?.();
    if (!node) return;

    function onWheel(e: WheelEvent) {
      node!.scrollLeft += e.deltaY;
      e.preventDefault();
    }

    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [ref]);
}
