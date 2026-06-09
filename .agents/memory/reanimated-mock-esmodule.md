---
name: reanimated mock __esModule + RN render-path strategy
description: Three traps that cause "Element type is invalid" when a test fires onLayout and exercises the full WarehouseMapView render tree (containerW > 0).
---

## Rule

When writing a test that exercises any re-render of WarehouseMapView (or any RN component) past an early-return gate, three things must be correct.

### Trap 1 — `__esModule: true` in the reanimated mock

`jest.mock("react-native-reanimated", () => ({ default: { View: AnimatedView, ... }, ... }))` — without `__esModule: true`, ts-jest CJS interop assigns the **entire module object** as the default import. So `import Animated from "react-native-reanimated"` receives `{ default: { View: ... }, useSharedValue: ... }`, making `Animated.View === undefined`. Rendering `<Animated.View>` then throws "Element type is invalid".

**Fix:** add `__esModule: true` as the first key in the mock's return object.

**Why it's invisible without layout:** any test that never fires `onLayout` keeps `containerW = 0` and hits the early return — `<Animated.View>` is never rendered, so the undefined is never exercised. The gold-standard `warehouseMapCacheCleanup.test.tsx` never fires layout and therefore passes with the broken mock.

### Trap 2 — `svgUri` must be `""` in MOCK_CACHED_DATA

Setting `uri: "/floor-plan/svg"` (non-empty) causes the condition `(svgUri || svgXml)` to be `true` in the render, entering the tile-render branch which contains more `<Animated.View>` usages (and PngTile). These all blow up for the same reason as Trap 1 (before that fix) or from other missing mocks. Keep `uri: ""` and `xml: ""` so the component takes the safe "Map unavailable" branch.

### Trap 3 — `IS_REACT_ACT_ENVIRONMENT = true`

React 19 requires `global.IS_REACT_ACT_ENVIRONMENT = true` for `act()` to flush synchronous state updates (e.g. `setContainerW` called from `onLayout`). Without it, React warns "not configured to support act()" and state updates may escape the `act()` scope, causing a re-render outside any protected context.

**Fix:** add `(global as any).IS_REACT_ACT_ENVIRONMENT = true;` as the very first line of the test file, before all imports and `jest.mock` calls.

## How to apply

Any time a test mounts WarehouseMapView (or a component with a similar early-return + `<Animated.View>` pattern) AND calls `fireOnLayout` or otherwise triggers a re-render past the gate:

1. Add `__esModule: true` to the reanimated mock.
2. Keep `svgUri = ""` and `svgXml = ""` in any cache mock to avoid tile-render path.
3. Add `IS_REACT_ACT_ENVIRONMENT = true` at the very top of the test file.
