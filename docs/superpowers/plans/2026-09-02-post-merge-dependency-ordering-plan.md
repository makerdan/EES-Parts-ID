# Implementation Plan: Post-Merge Dependency Ordering

## Source Spec
- Spec file: `docs/superpowers/specs/2026-09-02-post-merge-dependency-ordering-design.md`
- Approved by user: 2026-09-02

## Dependencies
- `pnpm` and the repository `pnpm-lock.yaml`
- The existing `scripts/post-merge.sh` install timeout and cleanup trap
- The existing API code-generation lock and `scripts/test-post-merge.sh`
- No new package, service, environment variable, migration, or deployment dependency

## Tasks

### T001: Wait for dependency installation before dependency-sensitive post-merge work
- **Blocked by**: []
- **Files**: `scripts/post-merge.sh`
- **Details**: Refactor the existing background-install result collection into a
  single helper that is invoked immediately after starting an install caused by
  a changed lockfile, before schema handling or API code generation. Preserve
  the bounded `CI=true pnpm install --frozen-lockfile` command, the existing
  exit trap, and clear timeout/non-zero diagnostics. Do not wait for an install
  twice or allow codegen to proceed after a failed install.
- **Done when**: A lockfile-changing post-merge run cannot reach database or
  codegen commands until the install has exited successfully; an install
  timeout or non-zero exit stops setup with an actionable message; the
  unchanged-lockfile path still skips installation.

### T002: Regression hardening — prove codegen waits for installation
- **Blocked by**: [T001]
- **Files**: `scripts/test-post-merge.sh`
- **Details**: Add a deterministic black-box test using mocked `git`, `timeout`,
  `pnpm`, and `curl`. Make the mocked install create a completion sentinel only
  when its simulated process exits, and make mocked codegen fail if it observes
  that sentinel missing. Assert the post-merge script succeeds only when the
  install completion is observed before codegen. Keep the existing tests for
  background install behavior, timeout handling, cleanup, codegen, and health
  checks.
- **Done when**: The focused post-merge test fails against the old ordering and
  passes against the new ordering, including the existing install timeout and
  cleanup assertions.

### T003: Synchronize dependencies and restore generated build state
- **Blocked by**: [T001]
- **Files**: `node_modules` and generated build outputs only as produced by the
  existing package/codegen commands
- **Details**: Run the repository's frozen dependency installation so the
  installed Orval version matches the lockfile. Remove stale workspace
  `tsconfig.tsbuildinfo` files only if needed to clear the observed generated
  barrel cache failure, then regenerate API clients and declarations through
  the existing `codegen:fix` path. Confirm the generated source and declaration
  barrels contain real exports and that any generated changes are committed
  through the existing post-merge behavior.
- **Done when**: The installed Orval version is 8.22.0, `codegen:fix` exits 0,
  generated barrels are valid modules, and the working tree contains no
  unintended generated drift.

### T004: Verify post-merge setup and validation
- **Blocked by**: [T002, T003]
- **Files**: No additional files
- **Details**: Run the focused post-merge test, then the registered
  `test-standard-plus` tier, and finally the configured post-merge setup. Check
  that the setup completes within its configured timeout and that API health,
  SVG viewBox synchronization, and workflow reconciliation succeed.
- **Done when**: `scripts/test-post-merge.sh`, `test-standard-plus`, and
  `runPostMergeSetup()` all complete successfully, with no new workflow or
  codegen error.

## Pre-existing failures to ignore

None known at plan time. The observed `orval: not found` and generated-barrel
`TS2306` failures are the behavior this plan owns and must repair.

**Flaky-test rule:** A passing retry establishes intermittency, not pre-existing
provenance. Use the execution evidence rules before assigning ownership.

## Task-local environment observations

- The current installed Orval is stale or absent while the lockfile requires
  Orval 8.22.0 because post-merge runs codegen before its background install
  completes.
- A prior retry also exposed stale `tsbuildinfo` behavior after generated
  output was rewritten.

## Validation
**Command:** `test-standard-plus`
**Why:** This change affects post-merge dependency ordering, code generation,
  generated declarations, and the existing post-merge health test; the
  standard-plus tier covers the focused regression suite and the full declared
  validation path without requiring the heavier tier.
**Do not escalate:** Run exactly this command. Pre-existing failures are not a
reason to run a heavier tier.

## Regression Guard
**Covers:** A future lockfile-changing merge starting database or API codegen
  while `pnpm install --frozen-lockfile` is still running, producing missing
  tools or incompatible generated outputs.
**Test location:** `scripts/test-post-merge.sh`
**What it checks:** A mocked install must finish and publish its completion
  sentinel before mocked codegen is allowed to run; the test fails if post-merge
  resumes dependency-sensitive work early.

## Validation tier
standard-plus