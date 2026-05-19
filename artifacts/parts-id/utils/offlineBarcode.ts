import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InventoryItem } from "@workspace/api-client-react";

export const FUSE_CACHE_KEY = "parts_id_fuse_cache_v2";

export async function lookupByBarcodeOffline(
  code: string,
): Promise<InventoryItem | null> {
  try {
    const raw = await AsyncStorage.getItem(FUSE_CACHE_KEY);
    if (!raw) return null;
    const items = JSON.parse(raw) as InventoryItem[];
    const match = items.find(
      (item) => Array.isArray(item.barcodes) && item.barcodes.includes(code),
    );
    return match ?? null;
  } catch {
    return null;
  }
}

export async function upsertItemInBarcodeCache(
  updatedItem: InventoryItem,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(FUSE_CACHE_KEY);
    const items: InventoryItem[] = raw ? (JSON.parse(raw) as InventoryItem[]) : [];
    const idx = items.findIndex((item) => item.id === updatedItem.id);
    if (idx >= 0) {
      items[idx] = updatedItem;
    } else {
      items.push(updatedItem);
    }
    await AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items));
  } catch {
    // Non-fatal: cache update failure should not surface to the user
  }
}
