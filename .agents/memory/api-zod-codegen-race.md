---
name: api-zod codegen race in repo-wide typecheck
description: Why the repo `typecheck` workflow can spuriously fail with TS6053 "file not found" under lib/api-zod/src/generated, and how to confirm it's a race.
---

The repo-wide `typecheck` workflow (`tsc --build` over libs) can fail with a burst
of `TS6053: File '.../lib/api-zod/src/generated/*.ts' not found` errors even when
nothing is actually wrong with your code.

**Why:** `lib/api-zod/src/generated/` (and `lib/api-client-react`) are codegen
outputs, produced by orval via the parts-id `predev` hook
(`pnpm --filter @workspace/api-spec run codegen`). If `typecheck` runs before that
codegen finishes on a cold environment, the generated files don't exist yet and
`tsc --build` fails. It's a startup ordering race, not a real type error.

**How to apply:** Before trusting a `typecheck` failure that points only at
`lib/api-zod/src/generated/*`, check whether the files exist now
(`ls lib/api-zod/src/generated`). If they do, just re-run typecheck — it will pass.
Real type errors name your own source files with specific TS codes (e.g. TS2339),
not a wall of TS6053 for generated paths.
