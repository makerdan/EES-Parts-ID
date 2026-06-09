---
name: Reanimated 4 worklets Babel plugin required for web
description: Without react-native-worklets/plugin in babel.config.js, useAnimatedProps/useAnimatedStyle throws on web in dev mode, cascading into React "Invalid hook call"
---

## Rule
`babel.config.js` must include `react-native-worklets/plugin` as the **last** plugin when using `react-native-reanimated@4.x`.

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", ...]],
    plugins: ["react-native-worklets/plugin"],  // MUST be last
  };
};
```

**Why:** Reanimated 4 moved worklet transforms into `react-native-worklets`. Without this plugin, callbacks passed to `useAnimatedProps`/`useAnimatedStyle` are NOT transformed into worklets — they have no `__closure` or `__workletHash`. On web, Reanimated's `useAnimatedStyle` checks `isWorkletFunction(updater)` and, in `__DEV__` mode, throws a `ReanimatedError` when neither worklet transform nor an explicit deps array is present. This throw happens mid-hook-call, corrupting React's internal hook counter. On the error-boundary recovery render, React sees mismatched hook calls and throws "Invalid hook call" — attributed to the nearest ancestor component.

**How to apply:** Any project using `react-native-reanimated@4.x` (which depends on `react-native-worklets`). `babel-preset-expo` does NOT include this plugin automatically — it must be added manually. The plugin resolves to `node_modules/react-native-worklets/plugin/index.js`.

**iOS vs web:** iOS is unaffected because the JSI native worklet runtime gracefully runs untransformed functions on the JS thread. Web has no JSI fallback.

**Belt-and-suspenders:** Also add `"use no memo"` to any sub-components in the same file that use Reanimated hooks (`useSharedValue`, `useAnimatedProps`, `useAnimatedStyle`) to prevent React Compiler interference.
