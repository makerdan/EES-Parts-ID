---
name: exports['.'] types condition for workspace libs
description: TypeScript moduleResolution:bundler resolves exports['.'] before the root types field; the condition object must include "types" explicitly.
---

## Rule

Workspace libs that set `"moduleResolution": "bundler"` (or `"node16"`/`"nodenext"`) in their consumers must declare the `types` condition **inside** `exports['.']`, not just at the root `types` field.

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "default": "./src/index.ts"
  }
},
"types": "./dist/index.d.ts"
```

The root `types` field is only consulted by older `moduleResolution: node` strategies. With `bundler`/`node16`, TypeScript reads `exports['.']` first and never falls back to the root field — so pointing `exports['.']` at a volatile source file (e.g. one cleaned by orval during codegen) causes intermittent TS2305 errors even though the root `types` is correct.

**Why:** Discovered during post-merge validation race: `codegen:check` and `typecheck` ran concurrently; orval cleaned `src/generated/` while tsc was resolving `exports['.'] = "./src/index.ts"`, producing 100+ TS2305 errors in 38 files intermittently.

**How to apply:** Any time a workspace lib is created or its `exports` field is set, ensure the `"."` entry is a conditions object with `"types"` pointing to compiled `dist/` declarations. Keep root `types` field as a fallback for older tooling.
