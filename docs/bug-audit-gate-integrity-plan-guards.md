# Bug & Error Audit Report

**Scope:** Validation gate integrity, Failure Gate, Regression Guard, plan
policy enforcement, plan scaffolding, and validation-baseline maintenance. The
audit did not inspect the tier runner, CI workflow implementation, or
application features except where they define the audited guard boundary.
**Mode:** report-only
**Date:** 2026-09-15
**Stack:** Bash and Node.js ESM validation tooling in a pnpm TypeScript
monorepo. TypeScript, linting, and contract-test gates are present; the
audited guard scripts themselves are JavaScript/Bash. React, backend, and
database-specific categories were not applicable to these scripts.

## Architecture inventory

- `.replit` names `Project` as the run-button workflow and delegates it to
  `test-fast`.
- `scripts/check-gate-integrity.sh` is the first tier step intended to protect
  that Project gate.
- `scripts/validation-steps.mjs` is the tier membership source of truth;
  `scripts/run-tier.mjs` performs fail-fast execution and
  `scripts/run-locked-tier.mjs` selects the plan-declared tier.
- `scripts/lib/tier-lock-check.mjs` is the completion-selection boundary. It
  requires one exact `## Validation` section, one registered command, and one
  matching legacy tier declaration before a task validation can start.
- `scripts/check-failure-gate.mjs` scopes plan checks and repairs through
  `TASK_PLAN_FILE`, with explicit archive and ad-hoc modes.
- `scripts/check-regression-guard.mjs` applies the corresponding
  task-scoped/archive guard to Regression Guard declarations.
- `scripts/new-plan.mjs` scaffolds baseline, validation, legacy-tier, and
  Regression Guard sections, then runs the Failure Gate repair pass.
- `scripts/lib/failure-baseline.mjs` validates the tracked baseline catalog;
  `scripts/maintain-validation-baseline.mjs` reports aging active records
  without changing the catalog.
- `scripts/test/failure-gate-contract.test.mjs` provides focused contract
  coverage. `replit.md` documents the session mandate and operator contract.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 2 |
| Medium | 4 |
| Low | 1 |

| # | Severity | Category | File:Line | One-line description |
|---:|---|---|---|---|
| 1 | High | State & data integrity | `scripts/check-gate-integrity.sh:30-53` | The Project gate check passes when the Project workflow is missing, uses the wrong task type, or has duplicate tasks. |
| 2 | High | State & data integrity | `scripts/check-failure-gate.mjs:64-66,142-152` | Failure Gate auto-repair can insert Validation fields into `## Validation tier` and leave the plan damaged. |
| 3 | Medium | Error handling | `scripts/check-failure-gate.mjs:21-26,171-173`; `scripts/check-regression-guard.mjs:15,75-80` | Placeholder detection is incomplete, so plans containing `TBD` or `<FILL IN>` can pass. |
| 4 | Medium | Error handling | `scripts/check-regression-guard.mjs:75-80` | A valid documented `**N/A**` Regression Guard declaration is rejected. |
| 5 | Medium | State & data integrity | `scripts/check-failure-gate.mjs:53-67,162-165`; `scripts/check-regression-guard.mjs:29-40`; `scripts/check-plan-tier.sh:39-40` | Guard parsers accept heading aliases and single-`#` headings instead of requiring the exact plan sections. |
| 6 | Medium | Error handling | `scripts/maintain-validation-baseline.mjs:9-13,20-31` | Invalid warning/evidence thresholds fail open and suppress maintenance findings. |
| 7 | Low | State & data integrity | `replit.md:82-83,214-215`; `scripts/validation-steps.mjs:127-138` | The session mandate says heavy is identical to standard-plus although the runner adds a heavy-only smoke step. |

## Findings

### Finding 1 — Project gate integrity check does not validate Project structure

- **File and line:** `scripts/check-gate-integrity.sh:30-53`
- **Category:** State & data integrity
- **Severity:** High
- **Risk:** The script searches for the literal `name = "Project"` and then
  only compares matching `args` lines. If the Project workflow is removed,
  renamed, changed to a `shell.exec` task, or given two `workflow.run` tasks
  both using `test-fast`, the script exits 0 with
  `Project CI gate is clean`. A realistic result is that `.replit` still
  points the run button at a missing or wrong workflow while the first gate
  reports success, so the intended merge validation is not reliably connected
  to the Project workflow. Probes against a missing Project block, a
  `shell.exec` Project task, and duplicate `test-fast` tasks all returned
  exit 0. The later `replit-config-contract` check catches some of these
  states, but that does not make this first-line gate guard correct.
- **Recommended fix:** Parse `.replit` as TOML or use a structural parser
  helper and fail closed unless a Project workflow is found with exactly one
  task whose `task` is `workflow.run` and whose `args` is `test-fast`.

### Finding 2 — Failure Gate repair can rewrite the wrong section

- **File and line:** `scripts/check-failure-gate.mjs:64-66,142-152`
- **Category:** State & data integrity
- **Severity:** High
- **Risk:** `validationBody` treats every heading beginning with
  `Validation ` as the Validation section. `ensureValidation` then uses
  `^## Validation\b`, which also matches `## Validation tier`. For a malformed
  plan containing only `## Validation tier\nstandard`, the unconditional
  `--fix-stub` step inserts `**Command:**`, `**Why:**`, and
  `**Do not escalate:**` between the tier heading and its value, then appends
  the pre-existing-failures stub. The probe exited 0 from repair but left the
  plan without a valid `## Validation` section and with the legacy tier
  declaration corrupted. A task agent can therefore lose the original
  structure and still need manual recovery before validation can proceed.
- **Recommended fix:** Match exact section headings for required sections.
  When `## Validation` is absent, append a new exact stub rather than
  replacing a prefix match; add a regression test for a plan containing only
  `## Validation tier`.

### Finding 3 — Placeholder detection can accept incomplete plans

- **File and line:** `scripts/check-failure-gate.mjs:21-26,171-173`;
  `scripts/check-regression-guard.mjs:15,75-80`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The Failure Gate placeholder list only recognizes four specific
  phrases and does not reject common placeholders such as `TBD` or
  `<FILL IN>`. A task plan with `**Why:** <FILL IN>` and
  `**Do not escalate:** TBD` passed the strict Failure Gate probe. The
  Regression Guard detector similarly accepts a declaration whose three
  required fields are all `TBD`. If an author or scaffold uses these
  placeholders, the plan can appear compliant while omitting the human
  decision the guard is intended to enforce. The completion boundary checks
  the selected command and tier, not the quality of these explanations.
- **Recommended fix:** Centralize and broaden placeholder detection for both
  guards to reject `TBD`, `TODO`, `FILL IN`, and equivalent blank/template
  values while preserving explicitly supported declarations such as `N/A`.
  Add contract tests for each accepted and rejected form.

### Finding 4 — Valid Regression Guard N/A declarations are rejected

- **File and line:** `scripts/check-regression-guard.mjs:75-80`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The Regression Guard policy explicitly permits
  `**N/A**` with a specific `**Why N/A:**` reason for real-time races,
  unmockable external behavior, visual regressions without screenshot
  infrastructure, and removed features. `issuesFor` recognizes only the
  three metadata fields or a self-satisfying declaration. A plan containing
  the documented race-condition N/A form failed the strict guard probe,
  incorrectly blocking a task whose guard is valid under policy.
- **Recommended fix:** Add an explicit N/A parser that requires both the
  `**N/A**` marker and a non-placeholder `**Why N/A:**` explanation, and add
  contract coverage for valid and invalid N/A reasons.

### Finding 5 — Required plan sections are matched by permissive prefixes

- **File and line:** `scripts/check-failure-gate.mjs:53-67,162-165`;
  `scripts/check-regression-guard.mjs:29-40`;
  `scripts/check-plan-tier.sh:39-40`
- **Category:** State & data integrity
- **Severity:** Medium
- **Risk:** The section parsers accept `#` as well as `##`, and the Failure
  and Regression guards accept headings such as `## Validation notes` and
  `## Regression Guard notes`. The tier checker also accepts any heading
  beginning with `## Validation tier`. Probes with single-`#` required
  sections and the `notes` aliases all exited 0. The task completion parser
  later rejects a non-exact Validation heading, but it does not validate the
  Regression Guard section; standalone guard runs can therefore report an
  invalid plan as compliant, and the different parsers disagree about the
  contract.
- **Recommended fix:** Require exact `## Pre-existing failures to ignore`,
  `## Validation`, `## Validation tier`, and `## Regression Guard` headings in
  every guard and in the standalone tier checker. Add negative tests for
  heading aliases, `#` headings, and suffixes.

### Finding 6 — Invalid baseline-maintenance thresholds suppress findings

- **File and line:** `scripts/maintain-validation-baseline.mjs:9-13,20-31`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** `Number()` converts missing, non-numeric, and negative threshold
  values without validation. With `--warning-days garbage`, a missing
  `--warning-days` value, or `BASELINE_MAX_EVIDENCE_DAYS=wat`, the comparisons
  against `NaN` are false and the command exits 0 while reporting no
  attention needed. An operator who mistypes a maintenance setting can
  therefore miss an approaching review deadline or stale evidence, allowing
  an active baseline to remain referenceable longer than intended. This is
  an informational maintenance command rather than the validation gate, so it
  does not directly authorize an ignore; it still produces a misleading
  health report.
- **Recommended fix:** Validate both thresholds as finite, non-negative
  integers before reading the catalog; reject missing or invalid CLI values
  with exit 2 and an actionable diagnostic. Add contract tests for invalid,
  negative, and valid zero thresholds.

### Finding 7 — Heavy-tier documentation is stale

- **File and line:** `replit.md:82-83,214-215`;
  `scripts/validation-steps.mjs:127-138`
- **Category:** State & data integrity
- **Severity:** Low
- **Risk:** The session mandate says `test-heavy` has the same steps as
  `test-standard-plus`, while the executable tier definition adds the
  `protected-map-concurrency` smoke step to heavy. A maintainer selecting
  heavy from the documented policy may not know that it has additional
  coverage or may incorrectly treat the tiers as interchangeable when
  diagnosing a result. The existing config contract intentionally confirms
  that this step is heavy-only, so this is documentation drift rather than a
  missing execution step.
- **Recommended fix:** Update the two heavy-tier descriptions to state that
  heavy includes the standard-plus steps plus `protected-map-concurrency`,
  or change the runner if identical tiers are the intended contract. Keep
  the documentation and `validation-steps.mjs` as one reviewed contract.

## Ten-category audit disposition

| Bug Audit category | Result |
|---|---|
| Null / undefined safety | No verified finding. The audited scripts use guarded file/path and section operations; no unguarded nullable access produced a confirmed failure. |
| Async & timing | Inapplicable to the audited guard and maintenance scripts: they are synchronous CLI paths with no timers, subscriptions, or promise lifecycle. |
| Error handling | Findings 3, 4, and 6. |
| Type safety | No verified finding in the audited JavaScript/Bash surfaces. The repository TypeScript check passed in the baseline. |
| State & data integrity | Findings 1, 2, 5, and 7. |
| Security | No verified finding. The audited paths do not authenticate users, query a database, or log secrets; command execution uses the fixed validation-step definitions. |
| Performance | Inapplicable to these short synchronous policy checks; no hot path or unbounded data processing was found. |
| Concurrency & shared state | No verified finding in scope. The audited scripts do not coordinate concurrent mutable application state; tier locking and process serialization were outside this focused audit except as boundary context. |
| Dead / unreachable code | No verified finding. Fast lint/Knip signals were clean for the repository baseline. |
| Dependency hygiene | No verified finding from the fast dependency-security and patched-dependency contract checks. A full package vulnerability audit was not run because the task required exactly the `test-fast` validation command. |

## Baseline and verification

- **Plan baseline:** The task plan declared no known pre-existing failures.
- **Required validation:** `pnpm run test-fast`
- **Result:** Passed, 27/27 steps, exit 0. The run waited 33.1 seconds for
  the shared validation lock and then completed in 38.8 seconds. The required
  command had no test failure requiring the three-retry rule.
- **Signals recorded:** TypeScript checks, lint, Knip, configuration
  contracts, port contracts, dependency-security contracts, and patched
  dependency checks all passed. The public-repository boundary step printed
  an informational list of 100 historical remediation paths but did not fail.
- **Focused probes:** Confirmed the seven findings above with temporary
  task/config fixtures. No tracked validation tooling was modified.
- **Completion-validation note:** The platform also ran broader tiers outside
  this task's validation ceiling; `test-standard`, `test-standard-plus`, and
  `test-heavy` each failed in the existing Parts ID
  `adminQueryWorkflow.test.tsx` suite because the `expo` test mock does not
  provide `useClerk`. Three isolated retries reproduced the same failure
  (`9/9` tests failed each time). This unrelated failure was not fixed or
  included in the audit scope.

## False positives rejected and out of scope

- The current `.replit` Project workflow is correctly configured with one
  `workflow.run` task and `test-fast`; the finding concerns the guard's
  behavior under malformed variants.
- The existing `replit-config-contract` test correctly checks the current
  workflow inventory and heavy-only smoke step; it does not eliminate the
  first-line shell guard or documentation/parser defects.
- Baseline catalog lifecycle matching, exact signatures, expired records, and
  ownership checks are enforced by `failure-baseline.mjs` and passed through
  the existing contract coverage; no additional baseline-reference defect was
  verified.
- Tier-runner implementation, GitHub Actions workflows, application routes,
  React behavior, database behavior, and the public-history remediation work
  were outside this task's scope.

## Report-only boundary

No validation tooling, plan guard, tier definition, session mandate, or
baseline catalog was changed. This file is the only deliverable from the
audit. The findings are intentionally deferred for maintainer prioritization.