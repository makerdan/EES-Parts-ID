---
name: RTLRN migration patterns
description: Key rules and traps discovered migrating 55+ parts-id test files from react-test-renderer to @testing-library/react-native v14.
---

## Core API differences

- `render()` is **async** — always `await render(...)`. Never wrap in `act()` (it handles act internally).
- `result.root` = `container.children[0]` — can be **undefined** when the component returns null. Guard helpers: `if (!root) return []`.
- `rerender()` and `unmount()` are also async — always await them.
- Never wrap `render()`, `rerender()`, or `unmount()` in a manual `act()` wrapper.

## SVG Text mock must use "Text" not "svg-text"

test-renderer@1.x enforces `textComponentTypes = ['Text', 'RCTText']`. Text strings are only allowed inside host elements of those types. SVG Text mocks must use `make("Text")`, not `make("svg-text")`.

**Why:** The reconciler throws "Text strings must be rendered within a <Text> component" when an emoji/number appears inside a non-text-host element like "svg-text".

**How to apply:** In react-native-svg mocks, set `Text: make("Text")`. Update assertions from `n.type === "svg-text"` to `n.type === "Text"`. The shared helper `createSvgMock()` in `__tests__/helpers/mapMocks.ts` already does this correctly.

## jest.isolateModules + render = afterEach-inside-test error

Calling `render()` inside `jest.isolateModules()` (which runs inside a test `it(...)`) triggers RTLRN's `addToCleanupQueue()` → `afterEach()`. Jest disallows `afterEach()` during a running test.

**Fix:** Capture component references inside `isolateModules`, move `render()` call outside:
```tsx
let capturedProvider;
jest.isolateModules(() => {
  // doMock setup + require components
  capturedProvider = require("../contexts/AppContext").AppProvider;
});
// render() OUTSIDE isolateModules
const result = await render(<capturedProvider />);
```

## Sync act() causes state leaks between tests

`act(() => { pressable.props.onPress() })` leaves async React work (effects, state updates) pending. The next test's `await render()` fires with unresolved async work, causing "overlapping act() calls" warnings and making the new render's root undefined or stale.

**Fix:** Always use `await act(async () => { pressable.props.onPress() })` for any call that triggers state changes.

## Fake timers + await render() inflate timer count

`await render()` internally schedules React scheduler `setTimeout(fn, 0)` calls. Under `jest.useFakeTimers()`, these appear in `jest.getTimerCount()`.

**Fix:** Use `jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] })` and assert on `setInterval`/`clearInterval` spy call counts rather than `jest.getTimerCount()`.
