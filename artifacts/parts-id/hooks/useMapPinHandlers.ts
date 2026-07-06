import type { InventoryItem } from "@workspace/api-client-react";
import { router } from "expo-router";
import { useCallback } from "react";

import type { PinnedPart } from "@/contexts/AppContext";
import { parseBin } from "@/lib/aisleHierarchy";

type SetPinnedParts = (
  value: Array<PinnedPart> | ((prev: Array<PinnedPart>) => Array<PinnedPart>),
) => void;

type SetPendingMapFocus = (focus: {
  aisleNum: number;
  sectionNum: number;
  label: string;
} | null) => void;

interface UseMapPinHandlersOptions {
  setPinnedParts: SetPinnedParts;
  setPendingMapFocus: SetPendingMapFocus;
  showToast: (message: string) => void;
}

/**
 * Returns stable `handleShowOnMap` and `handleVariantsToggle` callbacks shared
 * across the Search and Photo ID tabs. Both handlers manipulate the global
 * pinned-parts and map-focus state; extracting them here ensures any future
 * bug fix is made in exactly one place.
 */
export function useMapPinHandlers({
  setPinnedParts,
  setPendingMapFocus,
  showToast,
}: UseMapPinHandlersOptions) {
  const handleShowOnMap = useCallback(
    (item: InventoryItem) => {
      const bins = item.binLocations ?? [];
      if (bins.length === 0) {
        showToast("No bin location assigned — add a bin to this item first.");
        return;
      }
      const newPins: Array<PinnedPart> = [];
      let firstParsed: ReturnType<typeof parseBin> | null = null;
      for (const bin of bins) {
        const parsed = parseBin(bin);
        if (parsed) {
          if (!firstParsed) firstParsed = parsed;
          newPins.push({ binCode: bin, label: item.catalog, aisleNum: parsed.aisle });
        }
      }
      if (!firstParsed) {
        showToast(`No map zone found for "${bins[0]}" — bin format not recognised.`);
        return;
      }
      setPinnedParts(newPins);
      setPendingMapFocus({
        aisleNum: firstParsed.aisle,
        sectionNum: firstParsed.section,
        label: `Aisle ${String(firstParsed.aisle).padStart(2, "0")} · Section ${firstParsed.section}`,
      });
      router.navigate("/(tabs)/map");
    },
    [setPendingMapFocus, setPinnedParts, showToast],
  );

  const handleVariantsToggle = useCallback(
    (item: InventoryItem, variantItems: Array<InventoryItem>, isOpen: boolean) => {
      if (!isOpen) {
        // Only remove variant pins that belong to THIS item via groupId.
        // Other expanded cards' variant pins remain on the map, allowing
        // multiple cards to be expanded simultaneously without interfering.
        setPinnedParts((prev) => prev.filter((p) => !(p.variant && p.groupId === item.id)));
        return;
      }
      const variantPins: Array<PinnedPart> = [];
      for (const v of variantItems) {
        for (const bin of v.binLocations ?? []) {
          const parsed = parseBin(bin);
          if (parsed && v.id !== item.id) {
            variantPins.push({
              binCode: bin,
              label: v.catalog,
              aisleNum: parsed.aisle,
              variant: true,
              groupId: item.id,
            });
          }
        }
      }
      // Clear any existing pins for THIS item before adding fresh ones
      setPinnedParts((prev) => [
        ...prev.filter((p) => !(p.variant && p.groupId === item.id)),
        ...variantPins,
      ]);
    },
    [setPinnedParts],
  );

  return { handleShowOnMap, handleVariantsToggle };
}
