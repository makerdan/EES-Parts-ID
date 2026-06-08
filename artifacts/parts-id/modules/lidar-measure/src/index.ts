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
  cancelMeasure(): void;
};

function native(): NativeApi {
  return requireNativeModule<NativeApi>("LidarMeasure");
}

/**
 * Returns true when the LiDAR native module is genuinely present in this build
 * (i.e. not an Expo Go stub).  We probe by checking that `isLiDARSupported` is
 * an actual function on the module object — in Expo Go `requireNativeModule`
 * succeeds but returns a hollow stub without any of the real methods.
 *
 * Cached at module load so the check only runs once per JS context.
 */
const _nativeModuleAvailable: boolean = (() => {
  if (Platform.OS !== "ios") return false;
  try {
    const mod = requireNativeModule<NativeApi>("LidarMeasure");
    return typeof (mod as Record<string, unknown>).isLiDARSupported === "function";
  } catch {
    return false;
  }
})();

/**
 * Returns true when the current iOS device has a LiDAR scanner AND the native
 * module is available. Always false on Android and Web.
 */
export function isLiDARSupported(): boolean {
  if (Platform.OS !== "ios") return false;
  if (!_nativeModuleAvailable) return false;
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
 *   ERR_LIDAR_NOT_SUPPORTED – hardware or OS version missing, or native module
 *                             not bundled in this build (e.g. Expo Go)
 *   ERR_NO_FRAME            – AR session produced no frame
 *   ERR_NO_MESH             – no mesh anchors detected in time
 *   ERR_ZERO_DIMS           – geometry was degenerate (too small / too far)
 */
export function measureObject(timeoutSeconds = 4): Promise<LidarDimensions> {
  if (Platform.OS !== "ios") {
    return Promise.reject(new Error("LiDAR measurement is only available on iOS."));
  }
  if (!_nativeModuleAvailable) {
    return Promise.reject(
      new Error("ERR_LIDAR_NOT_SUPPORTED: LiDAR native module is not available in this build."),
    );
  }
  try {
    return native().measureObject(timeoutSeconds);
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * A full-screen native view that renders the live ARKit mesh wireframe overlay
 * on top of the device camera feed.  Mount this during the lidar_scanning phase
 * so the admin can see real-time depth feedback while the scan runs.
 *
 * The view shares the same ARSession as measureObject() via
 * LidarARSessionManager, so only one ARKit session is ever active at a time.
 *
 * iOS only — resolves to null on other platforms, and also null when the native
 * module is not genuinely present.  The guard prevents requireNativeViewManager
 * from being called in Expo Go: in that context it does NOT throw — it emits a
 * spurious "isn't exported by expo-modules-core" WARN and returns a stub
 * component, bypassing any try/catch.  By probing requireNativeModule first and
 * checking that isLiDARSupported is a real function (not a stub), we skip the
 * requireNativeViewManager call entirely when the module is absent.
 */
const NativeLidarDepthView: React.ComponentType<{
  style?: object;
  unit?: string;
}> | null = _nativeModuleAvailable
  ? (() => {
      try {
        return requireNativeViewManager("LidarDepthView");
      } catch {
        return null;
      }
    })()
  : null;

/**
 * Cancels an in-progress measureObject() call, pauses the ARSession, and
 * rejects the outstanding promise with ERR_INTERRUPTED.  Safe to call even
 * when no scan is running.
 */
export function cancelMeasure(): void {
  if (!_nativeModuleAvailable) return;
  try {
    native().cancelMeasure();
  } catch {
    // no-op if native module is unavailable
  }
}

export { NativeLidarDepthView };
