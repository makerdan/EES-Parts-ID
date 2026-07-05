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
