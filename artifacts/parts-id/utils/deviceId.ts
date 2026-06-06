/**
 * Stable per-install device identifier.
 *
 * Generates a UUID v4 on first use and persists it in AsyncStorage so the
 * same ID is returned on every subsequent call, even across app restarts.
 * The ID survives app updates but is reset on a full uninstall/reinstall.
 *
 * Used as the `X-Device-ID` request header on estimate-dimensions calls so
 * that the server can apply per-device rate limiting instead of per-IP, which
 * allows multiple devices on the same corporate NAT / Wi-Fi to each receive
 * their own independent quota.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const DEVICE_ID_KEY = "parts_id_device_id_v1";

let cached: string | null = null;

/** RFC 4122 UUID v4 (random). Runs entirely in JS — no native module needed. */
function generateUuidV4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Returns the stable device ID, creating and persisting one on first call.
 * Subsequent calls within the same JS runtime return the in-memory cached value
 * without hitting AsyncStorage.
 */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;

  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      cached = stored;
      return cached;
    }
  } catch {
    // Storage read failed — fall through to generate a fresh ID.
    // The generated ID will not be persisted this time, but the next successful
    // write will stabilise it.
  }

  const id = generateUuidV4();

  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Persist failure is non-fatal; a new ID will be generated next cold start.
  }

  cached = id;
  return cached;
}
