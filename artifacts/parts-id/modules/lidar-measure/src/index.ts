import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import { Platform } from "react-native";
import React from "react";

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

/**
 * A full-screen native view that renders the live ARKit mesh wireframe overlay
 * on top of the device camera feed.  Mount this during the lidar_scanning phase
 * so the admin can see real-time depth feedback while the scan runs.
 *
 * The view shares the same ARSession as measureObject() via
 * LidarARSessionManager, so only one ARKit session is ever active at a time.
 *
 * iOS only — on other platforms this resolves to null and is not rendered.
 */
const NativeLidarDepthView: React.ComponentType<{ style?: object }> | null =
  Platform.OS === "ios"
    ? (() => {
        try {
          return requireNativeViewManager("LidarDepthView");
        } catch {
          return null;
        }
      })()
    : null;

export { NativeLidarDepthView };
