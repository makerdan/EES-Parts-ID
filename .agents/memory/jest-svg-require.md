---
name: Jest SVG require throws before Asset.loadAsync
description: require("*.svg") in Jest without a moduleNameMapper entry throws SyntaxError synchronously, silently preventing Asset.loadAsync from ever being called.
---

# Jest SVG require throws before Asset.loadAsync

## The Rule
When testing a React Native component that calls `require("path/to/file.svg")` inside an async function (e.g. inside `_loadFloorPlanFromBundle`), Jest will throw a **SyntaxError** while trying to parse the SVG as JavaScript — synchronously, before the `Asset.loadAsync(...)` call is ever reached. The rejected Promise propagates to the outer `.catch`, calling `setFallbackEmpty()` instead of loading the SVG.

**Fix**: add a `moduleNameMapper` entry in `jest.config.js`:
```javascript
"\\.svg$": "<rootDir>/__mocks__/svg-asset.js"
```
And create `__mocks__/svg-asset.js`:
```javascript
module.exports = 1; // Metro uses numeric asset IDs
```

**Why:** Jest's default transform only handles `.tsx?` files. SVG files have no transform, so `require("*.svg")` fails at parse time. The error is swallowed by the Promise `.catch` chain, making the failure completely invisible — no test error message, just "function was never called".

**How to apply:** Any time a test exercises a code path that contains `require("*.svg")` (typically inside `Asset.loadAsync(require(...))` calls), this mapper is needed. The mapper must be placed BEFORE the catch-all `"^@/(.*)$"` mapper to avoid ordering issues.
