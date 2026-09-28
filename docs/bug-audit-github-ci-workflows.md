# Bug & Error Audit Report

**Scope:** Tracked GitHub Actions workflows, the shared Node/pnpm action,
required-status aggregation, workflow-contract validation, and the read-only
GitHub validation evidence collector.
**Mode:** report-only
**Date:** 2026-09-15
**Stack:** GitHub Actions YAML, Bash, JavaScript, and TypeScript repository
tooling. The workflow surface was audited instead of application behavior. The
TypeScript gate applies to the repository, but no separate application
type-safety finding was inferred from workflow configuration.

## Evidence and limits

This audit used:

- `.github/workflows/ci.yml`
- `.github/workflows/scheduled-audit.yml`
- `.github/workflows/sync-readme.yml`
- `.github/actions/setup-node-pnpm/action.yml`
- `scripts/test/github-actions-contract.test.mjs`
- `scripts/lib/github-validation-evidence.mjs`
- `docs/validation/github-actions-coverage.md`
- `docs/validation/ci-validation-parity.md`
- `docs/validation/github-protection-status.md`
- `docs/validation/github-actions-installation.md`

The protection and run documents are dated read-only snapshots, not a live
provider query performed by this audit. They identify `CI / required` as the
required branch-protection context in the available evidence. The latest
parity snapshot records merge-queue activation as unknown. No workflow was
dispatched, rerun, cancelled, approved, or changed, and no repository setting
was changed.

## Workflow inventory

| Workflow/job | Triggers | Permissions | Dependencies and execution | Status behavior |
|---|---|---|---|---|
| `CI` / `Portable validation` | Pull requests (`opened`, `synchronize`, `reopened`, `ready_for_review`), merge queue (`checks_requested`), push to `main`, manual dispatch | `contents: read` at workflow and job scope | Pinned checkout; shared Node/pnpm setup; PostgreSQL 16.4; readiness loop; isolated schema push; `pnpm run test-standard-plus` | The validation job fails normally. Opt-in Poe validation is `continue-on-error`; diagnostics upload is `always()` and `continue-on-error`, so neither can make the required result green. |
| `CI` / `CI / required` | Same workflow events | `contents: read` | `if: always()`, `needs: [validate]`; reads `needs.validate.result` | Explicitly fails for `failure`, `cancelled`, `skipped`, empty, and unexpected results. This is the available stable required context. |
| `Scheduled security audit` / `Daily dependency audit (low+)` | Daily schedule and manual dispatch | `contents: read` | Pinned checkout; shared setup; expiry guard; `pnpm audit --audit-level=low` with two documented advisory exceptions | A setup or audit failure fails this maintenance job. It is not a pull-request required status. |
| `Sync README from replit.md` / `Copy replit.md → README.md` | Weekly schedule and manual dispatch | `contents: write` | Checkout with credentials; copy `replit.md`; force-with-lease push to `automation/sync-readme`; print compare/PR URL | Maintenance writer, not validation. The commit message contains `[skip ci]`. |
| `setup-node-pnpm` | Called by the three validation/maintenance workflows that install dependencies | No independent workflow permission | Node from `.node-version`; pinned pnpm input; lockfile-keyed pnpm-store cache; frozen install; no checkout | Shared prerequisite. External actions are SHA-pinned and the local action cannot perform the initial checkout. |

The portable CI required gate is fail-closed for dependency failure and
cancellation. Concurrency cancellation is enabled for pull-request and
merge-group runs, while the replacement run uses the same stable check name.
The live Poe check is explicitly optional and cannot alter the required result.
Artifact retention is bounded to seven days and is not used as a pass signal.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 0 |

| # | Severity | Category | File:Line | One-line description |
|---:|---|---|---|---|
| 1 | High | Security | `scripts/test/github-actions-contract.test.mjs:55-60, 709-710` | The contract validates only a hard-coded four-workflow list, so a newly added workflow can bypass the repository’s workflow safety checks. |
| 3 | Medium | Error handling | `.github/workflows/sync-readme.yml:44` | `[skip ci]` can suppress the required pull-request check for the automation branch and leave its maintenance PR pending. |
| 4 | Medium | Security | `.github/workflows/sync-readme.yml:3-6, 8-26` | Manual dispatch is not restricted to `main`, although the write-capable workflow is described and implemented as default-branch maintenance. |
| 5 | Medium | Error handling | `scripts/lib/github-validation-evidence.mjs:276-285` | The read-only evidence collector requests 100 runs/jobs but never follows pagination, so it can report incomplete or absent evidence. |

## Findings

### Finding 1 — New workflows can bypass the workflow safety contract

- **File and line:** `scripts/test/github-actions-contract.test.mjs:55-60, 709-710`
- **Category:** Security
- **Severity:** High
- **Risk:** `workflowNames` is a fixed array containing the current four YAML
  files, and the final validation constructs its input from that array. The
  contract does not enumerate `.github/workflows` or assert that the fixed
  inventory is complete. If a future change adds a fifth workflow with a
  mutable action reference, write permission, an unbounded job, an unsafe
  pull-request trigger, or a second misleading required-looking status, the
  fast contract still passes because the new file is never parsed. This is a
  direct path for a CI policy regression to reach the repository without the
  local contract reporting it.
- **Recommended fix:** Discover tracked workflow files from
  `.github/workflows` and validate every discovered file, while retaining an
  explicit classification/allowlist for expected workflow-specific rules.
  Add a negative fixture proving that an added unsafe workflow is rejected and
  that an unexpected workflow cannot silently disappear from the inventory.

### Finding 3 — README synchronization can suppress required CI

- **File and line:** `.github/workflows/sync-readme.yml:44`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The maintenance commit is created with `[skip ci]`. GitHub skips
  workflows triggered by `push` or `pull_request` for commits carrying a skip
  marker. If `automation/sync-readme` is opened as a pull request, the
  synchronize event for this commit can therefore produce no `CI / required`
  run, leaving the required check pending. If the branch is opened after this
  commit, the initial pull-request check can be skipped for the same reason.
  The gate fails closed rather than falsely passing, but the automated
  maintenance path becomes unmergeable or appears stale and requires manual
  intervention.
- **Recommended fix:** Remove `[skip ci]` from the maintenance commit and
  prevent unwanted recursion through the existing branch/event design or an
  explicit path/branch condition. Verify one generated maintenance PR reaches
  a completed `CI / required` result.

### Finding 4 — Write-capable manual maintenance can use a non-default ref

- **File and line:** `.github/workflows/sync-readme.yml:3-6, 8-26`
- **Category:** Security
- **Severity:** Medium
- **Risk:** `workflow_dispatch` permits a user to select a branch/ref, while
  `actions/checkout` has no explicit `ref` and therefore checks out the
  dispatch ref. The workflow then uses `contents: write` and publishes that
  ref’s `replit.md` into the shared `automation/sync-readme` branch. A manual
  run from a feature or stale branch can overwrite the maintenance output with
  unreviewed or obsolete content, despite the step being named “Checkout
  default branch for maintenance” and the compare URL always comparing against
  `main`. This requires an authorized manual dispatch, but it is an avoidable
  write-boundary ambiguity.
- **Recommended fix:** Restrict the job to the repository default branch and
  explicitly check out the default branch for both scheduled and manual runs.
  Keep the write permission scoped to the job, and add a contract test that
  rejects a write-capable maintenance workflow without an explicit default-ref
  guard.

### Finding 5 — Read-only validation evidence can be truncated without warning

- **File and line:** `scripts/lib/github-validation-evidence.mjs:276-285`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The collector passes `perPage: 100` to both workflow-run and job
  callbacks, then processes only the returned array. It does not inspect a
  pagination cursor, `Link` header, total count, or truncation marker. A
  revision with more than 100 returned runs (or a run with more than 100 jobs)
  can have matching evidence omitted. A caller can then see an empty or
  incomplete bundle and incorrectly conclude that the exact revision had no
  run, no failed job, or no diagnostic evidence. The collector is read-only,
  so this does not alter GitHub status, but it can misreport the status used in
  an audit or completion decision.
- **Recommended fix:** Follow provider pagination until the collection is
  complete, or emit an explicit `truncated`/`incomplete` result and refuse to
  make a definitive absence claim. Add fixtures covering multiple pages for
  both workflow runs and jobs, including a matching run beyond page one.

## Ten-category audit disposition

| Category | Result |
|---|---|
| Null / undefined safety | No verified workflow-surface finding. YAML expressions and collector inputs were traced at the inspected boundaries. |
| Async & timing | No verified finding. Pull-request and merge-group concurrency cancellation is explicit; the required job uses `always()` and inspects the dependency result. |
| Error handling | Findings 3 and 5. Optional artifact/provider paths are visibly non-blocking and are not used as required pass signals. |
| Type safety | TypeScript is present and covered by the fast tier; no workflow-specific type-boundary defect was verified. |
| State & data integrity | Finding 2. The native validation result is not represented in the required branch gate. |
| Security | Findings 1 and 4. The contract has a blind spot for new workflows, and the write-capable manual path does not pin its source ref. |
| Performance | No verified finding. Jobs have finite timeouts and dependency caching is lockfile-keyed; no retry or unbounded validation loop is configured. |
| Concurrency & shared state | No separate verified finding. The README branch uses `force-with-lease`, and validation cancellation is scoped to superseded PR/merge-group runs. |
| Dead / unreachable code | No verified finding. The optional Poe and artifact branches are reachable by explicit conditions and are documented as optional. |
| Dependency hygiene | No verified workflow finding. External action references are SHA-pinned, installs are frozen, and the fast dependency-security contract passed. |

## Required-gate and diagnostic review

- **Fail closed:** `CI / required` is unconditional, depends on `validate`,
  and rejects success values other than exactly `success`. Cancellation,
  skipped dependencies, empty results, and unexpected results fail.
- **Optional jobs and steps:** The live Poe provider check and diagnostic
  uploads are explicitly `continue-on-error`. They cannot turn a failed
  portable validation job into a successful required result.
- **Cancellation:** Pull-request and merge-group runs cancel in progress by
  stable ref/PR group. The required job fails closed when its dependency is
  cancelled. Push-to-`main`, scheduled, and manual runs are not cancelled by
  the validation concurrency expressions.
- **Pagination:** The collector requests 100 items but does not continue to
  later pages (Finding 5). The workflow contract itself has a separate
  inventory blind spot (Finding 1).
- **Diagnostics:** CI artifacts are bounded to seven days and uploads are
  non-blocking. Missing artifacts cannot create a false pass, but the evidence
  collector can make an incomplete remote record look definitive unless
  pagination is fixed.

## Tooling signals (Phase 0)

- **Typecheck:** Passed as the `tsc` step inside `pnpm run test-fast`.
- **Lint:** Passed as the `lint` and `lint-mocks` steps inside
  `pnpm run test-fast`.
- **Tests:** `pnpm run test-fast` passed all 27 of 27 steps, including the
  GitHub Actions contract. No retry was needed.
- **Dependency audit:** The dependency-security contract and patched-
  dependency checks passed inside `pnpm run test-fast`. A full `pnpm audit`
  was not run separately because the task validation ceiling requires exactly
  `pnpm run test-fast`.

## Deferred / not audited

- No live GitHub API query or remote workflow run was made during this audit.
  Current branch protection, merge-queue activation, check-run behavior, and
  provider pagination headers remain subject to the evidence limits above.
- No application behavior tested by CI was audited.
- No workflow, validation code, branch setting, or repository setting was
  changed. The only repository change for this task is this report.
- Findings are report-only. Fixes, regression tests, and remote verification
  are deferred until separately approved.