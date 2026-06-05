import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

export interface LidarDimensions {
  length: number;
  width: number;
  height: number;
}

type NativeApi = {
  isLiDARSupported(): boolean;
  measureObject(timeoutSeconds: number): Promise<LidarDimensions>;
};

function native(): NativeApi {
  return requireNativeModule<NativeApi>("LidarMeasure");
}

/**
 * Returns true when the current iOS device has a LiDAR scanner AND the native
 * module is available. Always false on Android and Web.
 */
export function isLiDARSupported(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    return native().isLiDARSupported();
  } catch {
    return false;
  }
}

/**
 * Runs an ARKit scene-reconstruction session for `timeoutSeconds` seconds,
 * then returns the bounding-box dimensions of the nearest detected surface.
 *
 * Dimensions are in millimetres, sorted length ≥ width ≥ height.
 *
 * Rejects with one of:
 *   ERR_LIDAR_NOT_SUPPORTED – hardware or OS version missing
 *   ERR_NO_FRAME            – AR session produced no frame
 *   ERR_NO_MESH             – no mesh anchors detected in time
 *   ERR_ZERO_DIMS           – geometry was degenerate (too small / too far)
 */
export function measureObject(timeoutSeconds = 4): Promise<LidarDimensions> {
  if (Platform.OS !== "ios") {
    return Promise.reject(new Error("LiDAR measurement is only available on iOS."));
  }
  return native().measureObject(timeoutSeconds);
}
