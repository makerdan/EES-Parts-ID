/**
 * Manual Jest mock for react-native-gesture-handler.
 *
 * Captures the onEnd callback registered by Gesture.Tap().runOnJS().onEnd()
 * so tests can invoke it directly via __simulateTap().
 */
const React = require("react");

let _lastOnEnd = null;

const Gesture = {
  Tap: function () {
    const gesture = {
      runOnJS: function () {
        return gesture;
      },
      onEnd: function (cb) {
        _lastOnEnd = cb;
        return gesture;
      },
    };
    return gesture;
  },
};

function GestureDetector({ children }) {
  return React.createElement(React.Fragment, null, children);
}

function __simulateTap() {
  if (!_lastOnEnd) throw new Error("No Gesture.Tap onEnd callback registered");
  _lastOnEnd();
}

function __resetTap() {
  _lastOnEnd = null;
}

module.exports = { Gesture, GestureDetector, __simulateTap, __resetTap };
