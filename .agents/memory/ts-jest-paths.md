---
name: ts-jest inline tsconfig paths
description: When ts-jest uses an inline tsconfig object, it does not inherit paths/baseUrl from the real tsconfig.json — all path mappings must be listed explicitly in the inline config.
---

## Rule

When `transform` in `jest.config.js` uses an inline tsconfig object like `{ tsconfig: { strict: true, jsx: "react" } }`, ts-jest does **not** read the workspace's `tsconfig.json` at all. Any `paths` or `baseUrl` from `tsconfig.json` are invisible to TypeScript inside Jest.

**Fix:** Explicitly add `baseUrl` and every needed `paths` entry to the inline config object.

```js
["ts-jest", {
  tsconfig: {
    strict: true,
    jsx: "react",
    baseUrl: ".",
    paths: {
      "@/*": ["./*"],                                              // re-declare local alias
      "@workspace/zone-validation": ["../../lib/zone-validation/src/index.ts"],
    },
  },
}]
```

**Why:** ts-jest treats the inline object as the complete compiler options — it does not merge with the nearest tsconfig.json. Without `baseUrl`, `paths` is also silently ignored by TypeScript itself.

**How to apply:** Any time a new `@workspace/*` package or path alias is added to `tsconfig.json`, mirror it in the ts-jest inline config in `artifacts/parts-id/jest.config.js`. The `moduleNameMapper` in jest.config.js handles *runtime* resolution; the inline tsconfig `paths` handles *type-checking* resolution — both are needed.

## Corollary: pnpm-cached workspace packages can be stale

When a local workspace package is updated, its copy under `node_modules/.pnpm/` may still reflect an older version. If the inline tsconfig `paths` does not point to local source, ts-jest can fall back to that stale cached copy and report missing exports (`TS2305`).

**Fix:** Add local workspace packages to the ts-jest `paths` so type-checking resolves the current source rather than a cached package copy.
