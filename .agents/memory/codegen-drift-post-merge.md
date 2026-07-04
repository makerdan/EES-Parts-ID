---
name: Codegen drift in post-merge script
description: Task agents regenerate lib/api-zod and lib/api-client-react but can't commit to main; post-merge codegen:check then fails.
---

## The rule
After any task merge that touches `lib/api-spec/openapi.yaml` or that runs `pnpm --filter @workspace/api-spec run codegen`, the generated files in `lib/api-zod/src/generated/` and `lib/api-client-react/src/generated/` may be ahead of what's committed on main. The post-merge script's `codegen:check` step then fails with a non-empty `git diff --exit-code`.

**Why:** Task agents regenerate files in their isolated environment but only their own changes get merged. The codegen output is deterministic, so the fix is always just running codegen on main and committing the result.

**How to apply:**
1. Wait for the git index lock to clear (task merges hold it; check with `ls .git/index.lock`).
2. Run `pnpm --filter @workspace/api-spec run codegen` — it regenerates both targets and runs `typecheck:libs` to confirm they compile.
3. Stage and commit the generated files: `git add lib/api-client-react/src/generated lib/api-zod/src/generated`.
4. The post-merge script will pass on subsequent merges.

**Note:** The CI `codegen-check` job (added in Task #76) now blocks PRs that commit stale stubs, so this issue should become less frequent over time. But concurrent merges can still cause it transiently on main.
