/**
 * Tests for the orientation-lock error handler used in the Map tab.
 *
 * The map screen calls ScreenOrientation.lockAsync / unlockAsync and attaches
 * swallowOrientationNotAvailable as the catch handler. The contract is:
 *
 *   - "not available" errors are silently swallowed — these come from devices
 *     or simulators that don't support orientation locking (iPad split-view,
 *     web, certain simulators). Surfacing them as unhandled rejections would
 *     crash the app for no user-visible benefit.
 *
 *   - Any other error must be re-thrown so it reaches error monitoring. Without
 *     this re-throw a silent catch-all would hide real bugs.
 */

import { swallowOrientationNotAvailable } from "@/utils/orientationLock";

// ── "not available" errors are silently swallowed ─────────────────────────────

describe('swallowOrientationNotAvailable — "not available" errors', () => {
  it('swallows an Error whose message is exactly "not available"', () => {
    expect(() => {
      swallowOrientationNotAvailable(new Error("not available"));
    }).not.toThrow();
  });

  it('swallows an Error whose message contains "not available" among other text', () => {
    expect(() => {
      swallowOrientationNotAvailable(
        new Error("Orientation lock is not available on this device"),
      );
    }).not.toThrow();
  });

  it('swallows an Error with "not available" regardless of surrounding punctuation', () => {
    expect(() => {
      swallowOrientationNotAvailable(new Error("[ScreenOrientation] not available"));
    }).not.toThrow();
  });
});

// ── Unknown errors are re-thrown ─────────────────────────────────────────────

describe("swallowOrientationNotAvailable — unknown errors are re-thrown", () => {
  it("re-throws an Error with an unrelated message", () => {
    const err = new Error("Network request failed");
    expect(() => {
      swallowOrientationNotAvailable(err);
    }).toThrow(err);
  });

  it("re-throws an Error with an empty message", () => {
    const err = new Error("");
    expect(() => {
      swallowOrientationNotAvailable(err);
    }).toThrow(err);
  });

  it("re-throws a non-Error object (e.g. a plain string)", () => {
    expect(() => {
      swallowOrientationNotAvailable("something went wrong");
    }).toThrow("something went wrong");
  });

  it("re-throws a non-Error object (e.g. a plain object)", () => {
    const thrown = { code: 500, reason: "internal" };
    expect(() => {
      swallowOrientationNotAvailable(thrown);
    }).toThrow();
  });

  it("re-throws null (edge case: catch(null) is valid JS)", () => {
    expect(() => {
      swallowOrientationNotAvailable(null);
    }).toThrow();
  });

  it("re-throws an Error whose message only partially overlaps 'not available' (substring must match exactly)", () => {
    // 'available' alone is not enough — the full phrase "not available" must be present.
    expect(() => {
      swallowOrientationNotAvailable(new Error("available"));
    }).toThrow();
  });

  it('re-throws an Error with "NOT AVAILABLE" in a different case (match is case-sensitive)', () => {
    // The check uses String.prototype.includes which is case-sensitive.
    // If the device message ever changes case this test documents the expectation.
    expect(() => {
      swallowOrientationNotAvailable(new Error("NOT AVAILABLE"));
    }).toThrow();
  });
});
