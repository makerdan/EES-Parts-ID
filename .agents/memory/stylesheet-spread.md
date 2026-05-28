---
name: StyleSheet.create spread restriction
description: Metro Babel parser rejects spread operator inside StyleSheet.create() object literals.
---

Metro/Babel (React Native) rejects the spread operator (`...`) inside `StyleSheet.create()` object literals, producing a TransformError at the next property line:

```
TransformError SyntaxError: Unexpected token, expected "}" (line N)
```

**Example that BREAKS:**
```js
const styles = StyleSheet.create({
  myStyle: {
    ...StyleSheet.absoluteFillObject,  // ❌ crashes Metro
    alignItems: "center",
  },
});
```

**Fix — always use explicit properties:**
```js
const styles = StyleSheet.create({
  myStyle: {
    position: "absolute",  // ✅ expand manually
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
  },
});
```

**Why:** Metro's Babel configuration does not support object rest/spread inside `StyleSheet.create()` object literals. TypeScript compiles it fine but Metro's bundler transform fails.

**How to apply:** Any time you add or modify a `StyleSheet.create()` entry, never use `...spread`. Inline every property explicitly. Common expansions:
- `...StyleSheet.absoluteFillObject` → `position: "absolute", top: 0, left: 0, right: 0, bottom: 0`
