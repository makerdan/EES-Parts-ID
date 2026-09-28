# Implementation Plan: Post-merge setup with a paused API

## Source Spec
- Spec file: `docs/superpowers/specs/2026-09-27-post-merge-paused-api-design.md`
- Approved by user: 2026-09-27

## Dependencies
- Existing Bash, Node.js, pnpm, and the registered API port in `scripts/dev-ports.json`.
- Existing post-merge workflow reconciliation; no new package, secret, environment variable, or migration.
- The current assignment permits only `test-standard` as a registered tier. Its existing 420-second cap failed before standard-only tests; do not treat that result as a pass or rerun a broader tier.

## Tasks

### T001: Capture API activity before setup changes files
- **Blocked by**: []
- **Files**: `scripts/post-merge.sh`
- **Details**: At script entry, classify the API as active when `PORT` is explicitly supplied, its registered local port has a listener, or its development process exists. Freeze the classification for this invocation. When none is true, perform normal setup work but skip only the live health, port cleanup, sibling liveness, and viewBox probes; log clearly that live verification is deferred to workflow reconciliation. When active, preserve the existing strict retries, recovery, and failure path.
- **Done when**: A paused API is not started or swept by post-merge setup, while an API that was active at entry remains subject to its live health checks.

### T002: Regression hardening — paused is not mistaken for unhealthy
- **Blocked by**: [T001]
- **Files**: `scripts/test-post-merge.sh`
- **Details**: Exercise the no-`PORT`, no-process, no-listener path and assert setup finishes with a deferred message and no live health, port cleanup, or viewBox invocation. Exercise an active-at-entry path with unhealthy responses and assert setup fails instead of deferring. Keep existing explicit-`PORT` integration fixtures on the strict path.
- **Done when**: The focused post-merge test suite passes and both previously broken and fail-closed outcomes are asserted.

### T003: Verify the recovery path
- **Blocked by**: [T002]
- **Files**: none
- **Details**: Run `bash scripts/test-post-merge.sh`, inspect git status, and retry the configured post-merge setup. Confirm it finishes successfully against an active healthy API and logs the live checks. Do not run a tier above the assigned `test-standard` or claim the prior timed-out standard run passed.
- **Done when**: Focused tests and post-merge setup retry succeed, without a new validation-tier run outside the assignment.

## Pre-existing failures to ignore
None known in the post-merge test suite at plan time. Treat every focused-test failure as a potential regression.

**Flaky-test rule:** If a test fails, retry it 3× in isolation before concluding it is a regression you caused. Only treat a consistent 3/3 failure as your responsibility.

## Validation
**Command:** `test-standard`
**Why:** This is the only registered completion tier authorized by the active assignment; run the focused post-merge tests and setup retry independently to verify this repair while the tier's separate execution-limit question remains open.
**Do not escalate:** Run exactly this registered tier if reauthorized after its known timeout. Do not run standard-plus or heavy to verify this repair.

## Validation tier
standard

## Regression Guard
The paused-path fixture prevents the observed false setup failure from recurring; the active-but-unhealthy fixture prevents the new deferral from concealing a genuinely broken running server.