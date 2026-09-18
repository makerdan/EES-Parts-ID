/**
 * Manual Jest mock for react-native-gesture-handler.
 *
 * Unified mock that covers every gesture type used across the parts-id test
 * suite (Pan, Pinch, Tap, LongPress, Fling, Rotation, and the combinators
 * Simultaneous / Exclusive / Race).  Every gesture object is fully chainable —
 * all fluent builder methods return the same object so deep chains like
 *
 *   Gesture.Tap().runOnJS(true).onEnd(cb)
 *
 * work without any special setup.
 *
 * TAP SIMULATION API
 * ------------------
 * Gesture.Tap().onEnd() stores the registered callback in `_lastOnEnd`.
 * Tests that need to fire a tap call:
 *
 *   const gh = require("react-native-gesture-handler");
 *   gh.__simulateTap({ x: 50, y: 50 });   // fires the last registered onEnd
 *   gh.__resetTap();                        // clears the stored callback
 *
 * Call __resetTap() in afterEach (or rely on per-suite Jest module isolation)
 * to ensure callbacks do not bleed between tests.
 *
 * MIGRATION NOTE
 * --------------
 * This file supersedes the `createGestureHandlerMock()` factory in
 * __tests__/helpers/mapMocks.ts, which is now deprecated.  New test files
 * should use this mock by calling:
 *
 *   jest.mock("react-native-gesture-handler");
 *
 * and accessing __simulateTap / __resetTap via require().
 */

const React = require("react");

// ─── Chainable method list ────────────────────────────────────────────────────

/**
 * Every fluent builder method that any gesture chain in the codebase may call.
 * Each one simply returns the gesture object itself so chains are unbroken.
 * `onEnd` is intentionally omitted here; each gesture factory adds it
 * individually (Tap captures the callback; others are plain no-ops).
 */
const CHAINABLE_METHODS = [
  "onBegin", "onUpdate", "onFinalize",
  "onTouchesDown", "onTouchesUp", "onTouchesCancelled", "onTouchesMoved",
  "minDistance", "maxDistance", "minPointers", "maxPointers",
  "averageTouches", "enableTrackpadTwoFingerGesture",
  "simultaneousWithExternalGesture", "requireExternalGestureToFail",
  "blocksExternalGesture", "withTestId", "enabled",
  "shouldCancelWhenOutside", "hitSlop", "activeCursor",
  "runOnJS", "manualActivation", "numberOfTaps", "maxDuration",
  "maxDelay", "minNumberOfPointers",
];

/** Return a new fully-chainable gesture object with a no-op onEnd. */
function makeChainable() {
  const obj = {};
  CHAINABLE_METHODS.forEach((m) => { obj[m] = () => obj; });
  // Default no-op onEnd — overridden by Tap to capture the callback.
  obj.onEnd = () => obj;
  return obj;
}

// ─── Tap callback capture ────────────────────────────────────────────────────

let _lastOnEnd = null;

// ─── Gesture factories ───────────────────────────────────────────────────────

const Gesture = {
  /** Tap — captures the onEnd callback so __simulateTap() can invoke it. */
  Tap: function () {
    const obj = makeChainable();
    obj.onEnd = function (cb) {
      _lastOnEnd = cb;
      return obj;
    };
    return obj;
  },

  // All other factories are plain chainable objects.
  Pan:       makeChainable,
  Pinch:     makeChainable,
  LongPress: makeChainable,
  Fling:     makeChainable,
  Rotation:  makeChainable,

  // Combinators — accept any number of gesture args and return a chainable.
  Simultaneous: (..._args) => makeChainable(),
  Exclusive:    (..._args) => makeChainable(),
  Race:         (..._args) => makeChainable(),
};

// ─── GestureDetector ─────────────────────────────────────────────────────────

function GestureDetector({ children }) {
  return React.createElement(React.Fragment, null, children);
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Fire the most recently registered Gesture.Tap().onEnd() callback.
 *
 * @param {object} [event] - Optional event object forwarded to the callback.
 *   Defaults to an empty object.  Pass `{ x, y }` to simulate a real tap
 *   coordinate (though most tests rely on layout-derived coords anyway).
 * @throws {Error} if no onEnd callback has been registered yet.
 */
function __simulateTap(event) {
  if (!_lastOnEnd) throw new Error("No Gesture.Tap onEnd callback registered");
  _lastOnEnd(event !== undefined ? event : {});
}

/**
 * Clear the stored onEnd callback.  Call this in afterEach to prevent
 * callbacks from bleeding between tests in the same suite.
 */
function __resetTap() {
  _lastOnEnd = null;
}

module.exports = { Gesture, GestureDetector, __simulateTap, __resetTap };
