/**
 * @jest-environment node
 *
 * Unit tests for the lidar-measure JS layer.
 *
 * Covers two surfaces:
 *   1. The test-environment mock (__mocks__/lidar-measure.js) — verifies that
 *      callers relying on the mock see the correct interface and behaviour.
 *   2. The actual module source (modules/lidar-measure/src/index.ts) — verifies
 *      the pure-JS guards: non-iOS short-circuit and native-module error swallow.
 */

// ─── Section 1: mock interface ────────────────────────────────────────────────
// Imported via the moduleNameMapper entry in jest.config.js.

import {
  isLiDARSupported,
  measureObject,
} from "lidar-measure";

describe("lidar-measure mock (test-environment interface)", () => {
  describe("isLiDARSupported()", () => {
    it("returns false in the test environment", () => {
      expect(isLiDARSupported()).toBe(false);
    });

    it("returns a boolean (not undefined / null)", () => {
      expect(typeof isLiDARSupported()).toBe("boolean");
    });
  });

  describe("measureObject()", () => {
    it("rejects with an Error instance", async () => {
      await expect(measureObject()).rejects.toBeInstanceOf(Error);
    });

    it("rejects with the expected message", async () => {
      await expect(measureObject()).rejects.toThrow(
        "LiDAR not available in test environment"
      );
    });

    it("rejects even when a timeout argument is supplied", async () => {
      await expect(measureObject(10)).rejects.toThrow(
        "LiDAR not available in test environment"
      );
    });
  });
});

// ─── Section 2: actual module JS logic ────────────────────────────────────────
// Import directly from the source file so the moduleNameMapper is bypassed and
// we exercise the real JS guards (not the mock).

jest.mock("expo-modules-core", () => ({
  requireNativeModule: jest.fn(() => {
    throw new Error("Native module not found: LidarMeasure");
  }),
}));

import { requireNativeModule } from "expo-modules-core";
import * as RNModule from "../modules/lidar-measure/src/index";

const rnNativeModuleMock = requireNativeModule as jest.Mock;

// The Platform mock sets OS = "ios".  We mutate it per test group.
import * as RN from "react-native";
const platform = RN.Platform as { OS: string };

describe("lidar-measure source module – non-iOS guards", () => {
  const originalOS = platform.OS;

  afterEach(() => {
    platform.OS = originalOS;
    rnNativeModuleMock.mockReset();
    rnNativeModuleMock.mockImplementation(() => {
      throw new Error("Native module not found: LidarMeasure");
    });
  });

  describe("isLiDARSupported() on non-iOS platforms", () => {
    it("returns false on Android without touching the native module", () => {
      platform.OS = "android";
      expect(RNModule.isLiDARSupported()).toBe(false);
      expect(rnNativeModuleMock).not.toHaveBeenCalled();
    });

    it("returns false on web without touching the native module", () => {
      platform.OS = "web";
      expect(RNModule.isLiDARSupported()).toBe(false);
      expect(rnNativeModuleMock).not.toHaveBeenCalled();
    });
  });

  describe("isLiDARSupported() on iOS", () => {
    it("returns false when requireNativeModule throws (module not linked)", () => {
      platform.OS = "ios";
      expect(RNModule.isLiDARSupported()).toBe(false);
    });

    it("returns the value reported by the native module when it is available", () => {
      platform.OS = "ios";
      rnNativeModuleMock.mockReturnValue({ isLiDARSupported: () => true });
      expect(RNModule.isLiDARSupported()).toBe(true);
    });

    it("returns false when the native module reports no LiDAR hardware", () => {
      platform.OS = "ios";
      rnNativeModuleMock.mockReturnValue({ isLiDARSupported: () => false });
      expect(RNModule.isLiDARSupported()).toBe(false);
    });
  });

  describe("measureObject() on non-iOS platforms", () => {
    it("rejects immediately on Android with an iOS-only message", async () => {
      platform.OS = "android";
      await expect(RNModule.measureObject()).rejects.toThrow(
        "LiDAR measurement is only available on iOS."
      );
      expect(rnNativeModuleMock).not.toHaveBeenCalled();
    });

    it("rejects immediately on web with an iOS-only message", async () => {
      platform.OS = "web";
      await expect(RNModule.measureObject()).rejects.toThrow(
        "LiDAR measurement is only available on iOS."
      );
      expect(rnNativeModuleMock).not.toHaveBeenCalled();
    });
  });

  describe("measureObject() on iOS", () => {
    it("delegates to the native module on iOS", async () => {
      platform.OS = "ios";
      const fakeDims = { length: 200, width: 100, height: 50 };
      const nativeMeasure = jest.fn().mockResolvedValue(fakeDims);
      rnNativeModuleMock.mockReturnValue({
        isLiDARSupported: () => true,
        measureObject: nativeMeasure,
      });

      const result = await RNModule.measureObject(3);

      expect(nativeMeasure).toHaveBeenCalledWith(3);
      expect(result).toEqual(fakeDims);
    });

    it("uses 4-second default timeout when none is provided", async () => {
      platform.OS = "ios";
      const nativeMeasure = jest.fn().mockResolvedValue({ length: 100, width: 80, height: 60 });
      rnNativeModuleMock.mockReturnValue({
        measureObject: nativeMeasure,
      });

      await RNModule.measureObject();

      expect(nativeMeasure).toHaveBeenCalledWith(4);
    });

    it("propagates native module rejections without wrapping them", async () => {
      platform.OS = "ios";
      const nativeError = new Error("ERR_NO_MESH");
      rnNativeModuleMock.mockReturnValue({
        measureObject: jest.fn().mockRejectedValue(nativeError),
      });

      await expect(RNModule.measureObject()).rejects.toBe(nativeError);
    });
  });
});
