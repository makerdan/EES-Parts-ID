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
