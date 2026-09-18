---
name: api-zod codegen dev-boot clean race
description: Why dev predev must use an idempotent, locked codegen guard instead of raw orval clean
---

Dev boot race: `parts-id` and `api-server` start their dev workflows concurrently.
`orval` (lib/api-spec) uses `clean: true`, which deletes the shared generated dirs
(`lib/api-zod/src/generated/`, api-client-react generated) then rewrites them.
`api-server` statically imports `@workspace/api-zod` at startup; if it resolves the
barrel during that clean window it dies with ERR_MODULE_NOT_FOUND (no watch/retry).

**Rule:** dev `predev` for every artifact that imports the generated clients must go
through the shared idempotent guard (`codegen:ensure`), never raw `codegen`.

**Same rule for typecheck:** every tsc entry point must run `codegen:ensure` first,
or a cold env / concurrent orval-clean leaves generated files missing and tsc goes
red (TS2307 "Cannot find module './generated/api'"). Wired via `pretypecheck:libs`
at root (covers `typecheck`, `tsc`, `typecheck:libs`, and parts-id which calls
`pnpm -w run typecheck:libs` first) plus a `pretypecheck` on api-server (its tsc
imports api-zod but never touches typecheck:libs).

**Re-entrancy trap (must keep):** `codegen` ends with `pnpm -w run typecheck:libs`,
which now fires the `pretypecheck:libs` guard. A guard-triggered regen would spawn
`codegen` → nested `typecheck:libs` → guard again → deadlock on the lock the outer
guard holds. Fix: `codegen` sets `CODEGEN_ENSURE_SKIP=1` for its nested typecheck,
and `ensure-codegen.mjs main()` returns immediately when that env is set. Do NOT
remove either half.

**Guard invariants (the durable design decisions):**
- Serialize codegen across processes with a file lock so a destructive clean can
  never overlap another process' import.
- Never run codegen without holding the lock — if the lock can't be acquired, fall
  back to using the already-present output or fail loudly; running unlocked re-opens
  the race.
- Detect a crashed lock owner by PID liveness (same container), not by lock-dir age,
  so a slow-but-alive regeneration is never stolen mid-run.
- Skip orval entirely when an input hash (spec + orval config + post-codegen hook)
  matches a persisted marker AND all generated files exist; only regenerate when the
  spec actually changed or output is missing.

**Why the marker is gitignored:** first boot after a fresh checkout does one
redundant-but-safe regen (under the lock) to seed it; later boots skip.

**Do not** make `codegen` itself short-circuit — `codegen:check`/`codegen:fix`/post-merge
rely on it doing a full regen to detect drift. Add separate idempotent scripts instead.
