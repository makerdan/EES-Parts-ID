---
name: Stale tsbuildinfo leaves empty dist index.d.ts
description: tsc --build skips rebuilding when tsconfig.tsbuildinfo is stale-fresh, leaving a dist/index.d.ts containing only a sourcemap comment; symptom is TS2306 "is not a module".
---

A workspace lib's `dist/index.d.ts` can end up containing only `//# sourceMappingURL=...` (no exports) while `tsc --build` reports success, because the lib's `tsconfig.tsbuildinfo` claims outputs are up to date. Downstream consumers then fail with a wall of `TS2306: File '.../dist/index.d.ts' is not a module`, and `codegen:check`'s dist-declarations check flags line-1 drift against an "empty" committed file.

**Why:** tsbuildinfo timestamps can outlive a dist wipe/partial regeneration (e.g. interrupted codegen), so incremental build never re-emits the barrel file.

**How to apply:** when you see TS2306 "not a module" pointing at a workspace lib's dist barrel, `rm lib/<pkg>/tsconfig.tsbuildinfo` and re-run `pnpm -w run typecheck:libs`; verify `head dist/index.d.ts` shows real exports. Then re-run `codegen` + `dist:check`.
