---
name: Codegen drift in post-merge script
description: Post-merge now auto-commits generated file drift; manual cleanup is no longer needed.
---

## The rule
After any task merge that touches `lib/api-spec/openapi.yaml` or that runs `pnpm --filter @workspace/api-spec run codegen`, the generated files in `lib/api-zod/src/generated/` and `lib/api-client-react/src/generated/` may be ahead of what's committed on main.

**Why:** Task agents regenerate files in their isolated environment but only their own changes get merged. The codegen output is deterministic, so the fix is always running codegen on main and committing the result.

**How post-merge handles it (current behaviour):**
The post-merge script calls `pnpm --filter @workspace/api-spec run codegen:fix` instead of `codegen:check`. `codegen:fix`:
1. Runs `pnpm run codegen` (orval + typecheck:libs).
2. Checks `git diff --quiet` on the two generated dirs.
3. If changes exist, stages and commits them with the message `chore: regenerate api clients [post-merge]`.
4. Runs `spec:check` after.
5. Exits 0 whether or not a commit was made.

Manual cleanup is no longer needed — post-merge handles it automatically.

**CI/PR gate is unchanged:** `codegen:check` (used by the CI workflow, not post-merge) still asserts `git diff --exit-code` and blocks PRs that commit stale stubs.

**Note:** Concurrent merges can still produce transient drift on main, but post-merge will commit the fix as part of the second merge's run.
