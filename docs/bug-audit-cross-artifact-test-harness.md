# Bug & Error Audit Report

**Scope:** Cross-artifact test harnesses coordinating Canvas (`mockup-sandbox`),
Parts ID, and API Server, including suite discovery, command construction,
database/environment wrapping, time budgets, result manifests, cleanup, and
aggregate exit handling.

**Mode:** report-only

**Date:** 2026-09-15

**Stack:** Bash and Node.js/ESM orchestration around Vitest and Jest, with
pnpm workspace scripts and PostgreSQL test-mode protection. TypeScript,
React-specific, and application-level checks were not audited except where
their test-runner wrappers establish harness contracts. Payment and
authentication categories are not applicable to this harness scope.

## Executive summary

The harness correctly serializes shared test-result work, rejects ambiguous
database modes, propagates child exit failures, and applies per-suite timeout
budgets. The required `pnpm run test-fast` baseline passed all 27 fast-tier
steps.

Six verified harness findings remain. Two are high-severity false-success or
coverage risks: a passed suite with a missing/corrupt result artifact can be
reported as green, and the Parts ID fixed suite floor is materially below the
current test inventory. The root aggregator also has no positive test-count
assertion, so an all-skipped suite can satisfy exit-code-based success. The
outer watchdog does not cover preflight setup, and its intended second-stage
kill is unreachable after it signals its own process group. A sixth medium
finding records stale result files that can make timeout diagnostics describe a
previous run.

No harness or artifact tests were changed.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 4 |
| Medium | 2 |
| Low | 0 |

| # | Severity | Category | File:Line | One-line description |
|---:|---|---|---|---|
| 1 | High | Error handling | `scripts/test-timeout-report.mjs:89-96,172-176` | Missing or corrupt result JSON is treated as empty data while exit code 0 remains green. |
| 2 | High | State & data integrity | `artifacts/parts-id/scripts/run-tests.mjs:23-31` | The Parts ID suite floor is hard-coded at 94 although 179 matching test files are present. |
| 3 | High | State & data integrity | `scripts/test-all.sh:135-141`; `artifacts/parts-id/scripts/run-tests.mjs:97-100`; `artifacts/api-server/scripts/run-tests.mjs:199-202` | The aggregate accepts exit-code success without requiring a non-empty executed-test result. |
| 4 | High | Async & timing | `scripts/test-all.sh:22-37,73-88` | The outer wall-clock budget starts after uncapped codegen and contract preflight. |
| 5 | Medium | Async & timing | `scripts/test-all.sh:73-83` | The watchdog kills its own process group on the first signal, so its documented SIGKILL escalation cannot run. |
| 6 | Medium | State & data integrity | `scripts/test-all.sh:96-99`; `scripts/test-timeout-report.mjs:89-96` | Interrupted or timed-out runs can leave prior JSON that is reused as current diagnostics. |

## Scope map

### Launch and selection

The workspace `test` script invokes `scripts/test-all.sh`. The root harness
serializes the run under the `shared-test-results` resource, then launches the
three suites sequentially:

| Artifact | Root command | Runner/wrapper | Budget |
|---|---|---|---:|
| Canvas / mockup sandbox | `pnpm --filter ./artifacts/mockup-sandbox exec vitest run --reporter=json --outputFile=/tmp/jest-results-mockup-sandbox.json` | Vitest directly | 180 s |
| Parts ID | `pnpm --filter ./artifacts/parts-id run test -- --json --outputFile=/tmp/jest-results-parts-id.json` | `artifacts/parts-id/scripts/run-tests.mjs` → Jest | 300 s |
| API Server | `pnpm --filter ./artifacts/api-server run test -- --json --outputFile=/tmp/jest-results-api-server.json` | package database wrapper → serial lock → `artifacts/api-server/scripts/run-tests.mjs` → Jest | 240 s |

Parts ID uses a fixed minimum suite count. API Server discovers matching
`__tests__/**/*.test.ts` files and applies an 85% floor for full runs, while
disabling that floor for explicitly focused runs. The API suite-floor contract
also verifies floor-plan serialization and the default live-provider exclusion.

### Environment and database isolation

The API package defaults `DATABASE_ENV` to `test`, then
`scripts/run-database-command.mjs` refuses to run unless the inherited current
mode is explicitly `development` or `test`. It passes the selected
non-production mode to the child without allowing a production context to be
silently rewritten. The root validation tier additionally sets
`DATABASE_ENV=test` for the full root `test` step.

Canvas and Parts ID do not use the database wrapper. The root serialization
lock protects the shared `/tmp` result names and manifest from concurrent root
harness invocations. The API package adds its own serial lock around its Jest
wrapper.

### Budgets, manifests, and aggregate status

Each suite is run through GNU `timeout --kill-after=15s`; exit code 124 is
classified as `TIMED_OUT` and 137 is normalized to 124. The root script records
suite name, result path, wall time, budget, and exit code in
`/tmp/jest-run-manifest.json`, then calls `scripts/test-timeout-report.mjs`.
The root aggregate starts at zero, marks nonzero suite exits as failure, and
also fails if the diagnostic report exits nonzero.

The outer nominal cap is 1,080 seconds, but it is started only after codegen
and the API contract preflight. The watchdog is terminated by the root shell’s
normal-exit trap. The result files and manifest are not removed at the start
or after a normal run.

## Findings

### Finding 1 — Missing result artifacts can produce a false green report

- **File and line:** `scripts/test-timeout-report.mjs:89-96,172-176`;
  `artifacts/parts-id/scripts/run-tests.mjs:83-91`;
  `artifacts/api-server/scripts/run-tests.mjs:184-191`
- **Category:** Error handling
- **Severity:** High
- **Risk:** If a runner exits 0 but its caller-facing JSON cannot be written or
  copied, the timeout report silently treats the missing or corrupt file as
  having no test data. The suite status is derived from `exitCode === 0`, so
  the report exits 0 and prints `PASSED` without validating the result
  artifact. This can happen when the wrapper’s `copyFileSync` fails: both
  Jest wrappers log a warning but retain the successful child exit code.
  A bounded probe using a synthetic manifest with `exitCode: 0` and a missing
  result file returned exit 0 and printed `RESULT: All suites passed within
  their budgets.`
- **Recommended fix:** Treat a missing, unreadable, corrupt, or schema-invalid
  result file as a harness failure whenever the suite exit code is 0. Make
  caller-output copy failure change the wrapper exit status, and validate the
  expected runner result shape before allowing the aggregate to pass.

### Finding 2 — Parts ID’s fixed suite floor no longer represents the test tree

- **File and line:** `artifacts/parts-id/scripts/run-tests.mjs:23-31`
- **Category:** State & data integrity
- **Severity:** High
- **Risk:** The wrapper comments describe 107 matching test files and a floor of
  94, but the current repository contains 179 matching Parts ID `.test.ts` and
  `.test.tsx` files. The fixed floor therefore permits at least 85 matching
  files to disappear while the guard still passes. A broad test-discovery or
  module-load regression can consequently leave a green Parts ID suite with
  less than 53% of the current test files accounted for.
- **Recommended fix:** Compute the full-run floor from the live test tree, as
  the API wrapper does, or add a contract that fails when the fixed expected
  count diverges from the discovered count. Keep focused-run behavior
  explicitly exempted.

### Finding 3 — Exit-code success does not require any executed test

- **File and line:** `scripts/test-all.sh:135-141`;
  `scripts/test-timeout-report.mjs:85-98`;
  `artifacts/parts-id/scripts/run-tests.mjs:97-100`;
  `artifacts/api-server/scripts/run-tests.mjs:199-202`
- **Category:** State & data integrity
- **Severity:** High
- **Risk:** The root aggregator maps a runner exit code of 0 directly to
  `PASSED`; it does not require `numTotalTests`, non-todo assertion results, or
  any other positive execution evidence. The Parts ID and API wrappers also
  count `numPendingTestSuites` as “ran.” An accidental all-skipped or
  otherwise empty suite can therefore clear the suite floor and the root
  aggregate. A bounded synthetic pending-result manifest reproduced the
  timeout report’s green path: it returned exit 0 with one pending suite and
  no executed test results.
- **Recommended fix:** Require every full artifact run to report at least one
  executed test and reject all-pending/empty results unless the suite has an
  explicit, reviewed empty-run allowlist. Do not count pending suites as
  executed suites for the coverage floor.

### Finding 4 — Setup preflight is outside the total budget

- **File and line:** `scripts/test-all.sh:22-37,73-88`
- **Category:** Async & timing
- **Severity:** High
- **Risk:** `codegen:ensure` and the API suite-floor contract run before the
  watchdog is created. If package-manager resolution, the codegen lock, or the
  contract’s synchronous child process hangs, the nominal 18-minute outer
  budget and all per-suite timeout controls are inactive. The root validation
  command can remain blocked indefinitely without producing a manifest or
  aggregate result.
- **Recommended fix:** Establish the watchdog before all preflight work, or
  wrap each preflight command in an explicit bounded timeout. Preserve and
  propagate setup failures rather than allowing a timeout wrapper to mask them.

### Finding 5 — Watchdog escalation cannot reach its SIGKILL stage

- **File and line:** `scripts/test-all.sh:73-83`
- **Category:** Async & timing
- **Severity:** Medium
- **Risk:** The watchdog background subshell executes `kill -TERM 0`, which
  signals the entire process group, including the watchdog subshell itself.
  The subshell therefore terminates before it can sleep 15 seconds and run
  `kill -KILL 0`. A bounded shell probe using the same process-group pattern
  exited immediately after the first signal and never printed the second-stage
  marker. A descendant that ignores SIGTERM can survive the outer cap and
  continue consuming resources or interfere with later validation runs.
- **Recommended fix:** Put the workload and watchdog in a deliberately managed
  process group, signal the workload group without terminating the watchdog,
  and keep the watchdog alive through the grace period before force-killing
  survivors. Add an integration contract for a TERM-resistant child.

### Finding 6 — Prior result files can be reused in timeout diagnostics

- **File and line:** `scripts/test-all.sh:96-99`;
  `scripts/test-timeout-report.mjs:89-96`
- **Category:** State & data integrity
- **Severity:** Medium
- **Risk:** The root harness reuses fixed `/tmp/jest-results-*.json` paths but
  does not remove the prior file before starting a suite. If a runner is
  interrupted before replacing its output, the diagnostic script reads the
  previous run’s valid JSON. The suite still fails when its exit code is
  nonzero or timed out, so this is not a direct false-green path, but the
  slow-test and completed-test sections can identify tests that did not run in
  the current attempt and mislead incident triage.
- **Recommended fix:** Remove each result path before launch and include a
  per-run identifier or freshness marker in the manifest/result contract.
  Treat an absent current-run artifact as a diagnostic failure rather than
  falling back to an older file.

## Verified controls and non-findings

- **Child failure propagation:** `run-database-command.mjs` returns the child
  status and converts signal/no-status failures to exit 1. Bounded probes with
  child exits 7, thrown errors, and SIGTERM all returned nonzero.
- **Database environment isolation:** unset and `production` current modes are
  refused; `development`, `test`, and case-normalized `TEST` are accepted and
  the child receives the requested target mode.
- **Wrapper startup failures:** both Jest wrappers delete their internal result
  file before launch and fail when Jest does not write or cannot parse it.
- **Per-suite timeout aggregation:** root timeout and nonzero suite exits set
  the aggregate failure status. Timeout code normalization does not create a
  green result.
- **Suite selection contract:** the API floor contract passed and verified five
  floor-plan metadata-writer suites are isolated from the parallel project.
- **Post-merge and pre-commit harness cleanup:** the supporting shell test
  harnesses contain descendant cleanup and failure assertions. They were
  audited as supporting validation infrastructure, not as application tests.

## Ten-category audit coverage

| Category | Result |
|---|---|
| Null / undefined safety | Audited Node and shell result/status handling; no additional verified finding beyond missing result validation. |
| Async & timing | Applicable; Findings 4 and 5 cover uncapped preflight and watchdog escalation. |
| Error handling | Applicable; Finding 1 covers swallowed result-copy/report errors. Child nonzero propagation is otherwise present. |
| Type safety | Gated out for the orchestration files, which are Bash/JavaScript. TypeScript checks passed in the fast baseline but application types were out of scope. |
| State & data integrity | Applicable; Findings 2, 3, and 6 cover suite floors, empty/pending results, and stale artifacts. |
| Security | Audited command construction and database-mode boundary; no verified command-injection or production-database bypass in scope. |
| Performance | Budgets, serial locks, and result contention were reviewed; no additional verified performance bug. |
| Concurrency & shared state | Shared-result serialization and API serial locking were reviewed; the watchdog lifecycle issue is reported as Finding 5. |
| Dead / unreachable code | No additional verified dead or unreachable harness path. |
| Dependency hygiene | No dependency audit was run because the task’s declared validation ceiling is `pnpm run test-fast`; no dependency finding is claimed. |

## Tooling signals (Phase 0)

- **Typecheck:** clean in the required fast tier; the `tsc` step passed.
- **Lint:** clean in the required fast tier; the `lint` and `lint-mocks` steps
  passed.
- **Tests/contracts:** `pnpm run test-fast` passed all 27 of 27 steps,
  including the API suite-floor, validation-runtime, port-authority, and
  configuration contracts. The run waited 38.1 seconds for the validation lock
  and executed for 50.3 seconds after acquisition.
- **Dependency audit:** not run separately because the task explicitly requires
  exactly `pnpm run test-fast`; the fast-tier dependency-security and
  patched-dependency checks passed.
- **Harness syntax:** `bash -n` and `node --check` passed for the audited
  orchestration files.

## Deferred / not audited

- No individual Canvas, Parts ID, or API application test behavior was audited.
- No harness or artifact test was changed, and no finding was fixed.
- A direct all-skipped Vitest runtime probe was not completed because this
  workspace has no root `node_modules/.bin/vitest` path available to invoke
  outside the artifact package. The empty/pending finding is based on the
  verified exit-code-only source path and the bounded synthetic manifest probe.
- No heavier tier or full cross-artifact test workload was run, in accordance
  with the task’s validation ceiling.

## Confirmation

This is a report-only audit. The working tree was clean before the report was
added, and no harness or artifact tests were changed. The only deliverable
change is this repository-tracked report.