# Validation Test Coverage Bug Audit

**Scope:** Registered validation tiers, the cross-artifact test harness, result
publication and timeout reporting, CI parity contracts, and the heavy-only
protected-map concurrency smoke.

**Mode:** report-only

**Date:** 2026-09-23

**Repository revision:** `2ddf914fc78dc71a29cbe1f01113fae33dccc2ab`

**Stack:** Node.js 24 ESM scripts, Bash, pnpm workspace scripts, Jest/Vitest
JSON reporters, GitHub Actions, and React/Vitest route workflows. React
component behavior was considered only where it is exercised by the protected
map route suites. Live GitHub/provider inspection, native rendering, and
application behavior outside those route tests were out of scope.

No production code, validation test, workflow, tier membership, or baseline
catalog was changed by this audit.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 0 |

| # | Severity | Category | File:Line | One-line description | Resolution owner |
|---:|---|---|---|---|---|
| 1 | High | Error handling | `.github/workflows/ci.yml:106-119`; `scripts/test-all.sh:63-70,303-307` | CI uploads legacy paths after the harness has removed its current-run diagnostics. | Task #1849 (Keep validation diagnostics available after CI runs) |
| 2 | High | Error handling | `scripts/test-timeout-report.mjs:220-227,259-272` | A suite can report a wall-clock duration above its declared budget and still produce a green result. | Task #1848 (Make validation suite evidence fail closed) |
| 3 | Medium | Error handling | `scripts/test-timeout-report.mjs:103-116,147-159,356-358` | Missing suite identity is not rejected and instead causes an opaque formatter crash. | Task #1848 (Make validation suite evidence fail closed) |
| 4 | Medium | Error handling | `scripts/run-protected-map-smoke.mjs:167-172`; `scripts/test/protected-map-timeout-contract.test.mjs:51-102` | The focused contract never executes the CLI path that sets the heavy smoke's process exit code. | Task #1850 (Prove protected-map smoke failures exit nonzero) |
| 5 | Medium | Async & timing | `scripts/test-timeout-report.mjs:182-189,305-306` | Ordinary pending assertions are reported as todo, misclassifying incomplete evidence. | Task #1848 (Make validation suite evidence fail closed) |

The watchdog cleanup boundary is documented under Verified controls and
non-findings below. It is not an actionable finding and does not require a
task.

## Tier and execution inventory

### Registered local tiers

`scripts/validation-steps.mjs` defines cumulative tiers with these observed
sizes:

| Tier | Registered steps | Increment | Intended scope |
|---|---:|---|---|
| `fast` | 40 | — | Host/runtime contracts, static checks, focused contracts, typecheck, lint, and lightweight guards |
| `standard` | 52 | +12 | Fast plus codegen/spec/environment/privacy checks and the canonical database-backed test harness |
| `standard-plus` | 57 | +5 | Standard plus schema/FTS, API coverage, security audit, and post-merge health checks |
| `heavy` | 58 | +1 | Standard-plus plus `protected-map-concurrency` |

The positive tier contracts verified nonempty tiers, unique step names, ordered
prefixes, exactly one standard `test` step, declared host-tool coverage, and
the exact heavy-only addition. Package scripts register all four tiers through
the validation serial lock and `run-tier.mjs`.

### Portable CI boundary

`.github/workflows/ci.yml` invokes `pnpm run test-standard-plus` exactly once
after its PostgreSQL readiness, extension, schema, and generated-function
prerequisites. The required aggregator fails closed for failure, cancellation,
skipping, or an empty result. The parity contracts found one row for every
standard-plus member and correctly classify `protected-map-concurrency` as
absent from portable CI. Heavy is therefore local-only coverage; it is not
implicitly covered by standard-plus.

### Root test harness

The canonical `test` step runs `scripts/test-all.sh` under the shared test
results lock. The harness:

1. runs codegen and the API suite-floor contract as bounded preflight phases;
2. launches Canvas Vitest, Parts ID Jest, and API Server Jest sequentially;
3. wraps those legs in 180-second, 300-second, and 240-second timeouts;
4. writes staging evidence under a per-run temporary directory;
5. validates and atomically publishes each current result;
6. writes a per-run manifest; and
7. runs `scripts/test-timeout-report.mjs` against that manifest.

The focused runtime contract positively covered current, stale, missing, corrupt,
wrong-suite, contradictory, empty, all-pending, individual-budget, and
preflight-timeout cases. It did not cover suite wall-clock metadata overage,
missing suite identity, or the CI upload path.

## Heavy-tier execution

The required command was run with the assigned plan context:

```text
TASK_PLAN_FILE=.local/tasks/task-1828.md pnpm run test-heavy
```

It stopped at the exact registered step
`ci-validation-parity-revision-contract`:

```text
AssertionError: CI parity report repository revision mismatch:
expected=2ddf914fc78dc71a29cbe1f01113fae33dccc2ab
observed=fa1127dcee698b726f8bee7efa03a2c0bd140fc9
```

The run passed the first nine steps, failed at that step with exit 1, and
reported 49 later steps as `SKIPPED (fail-fast: not run)`. In particular, the
real `protected-map-concurrency` command did not run in this registered heavy
attempt. No claim that the three route suites passed is made here.

The stale parity header is a fail-closed validation stop, not a false-green
finding. Existing Task #1820 (Refresh CI parity evidence automatically after
repository revisions) owns the parity-refresh behavior. The audit did not
refresh the report because the assigned task forbids changing the baseline
evidence or validation documents outside this findings report.

### Protected-map coverage boundary

The heavy command is registered as
`pnpm --filter @workspace/mockup-sandbox run test:protected-map-smoke`, which
invokes `scripts/run-protected-map-smoke.mjs`. Its default route set is:

- `WarehouseMapRoute.test.tsx` — 3 route workflow tests;
- `ZoneEditorRouteWorkflow.test.tsx` — 5 route workflow tests; and
- `AnchorCalibrationRoute.test.tsx` — 7 route workflow tests.

The runner starts all three child processes through `Promise.all`, gives each
child an independent timeout, terminates its detached process group with
SIGTERM then SIGKILL, retains late results until escalation completes, reports
the owning route file, and sets CLI exit status 1 when any child fails.

The fast-tier focused timeout contract did run and passed:

```text
Protected-map timeout contract: normal completion, timeout ownership,
and descendant cleanup passed
```

That contract uses synthetic `normal-suite` and `term-resistant-suite` names.
It proves sibling-result retention, timeout ownership, SIGKILL escalation, and
descendant cleanup, but it does not run any real route suite, assert overlap
timing, or invoke the module's CLI entry point. A separate deterministic shim
run confirmed the current CLI returns exit 1 and reports all three failing
owners, but that behavior is not currently protected by the registered
contract. Task #1850 owns that regression assertion.

## Findings

### Finding 1 — CI cannot retain the current validation diagnostics

- **File and line:** `.github/workflows/ci.yml:106-119`;
  `scripts/test-all.sh:63-70,104-110,232-241,303-307`
- **Category:** Error handling
- **Severity:** High
- **Risk:** The harness writes its manifest and suite results under an isolated
  `RUNTIME_DIR`, runs the report from `MANIFEST_FILE`, and removes that
  directory from the exit trap. The CI artifact step runs afterward and still
  requests `/tmp/jest-run-manifest.json`, `/tmp/jest-results-*.json`, and
  `/tmp/test-timeout-report-*.txt`. The harness no longer writes those fixed
  files, and it does not write a timeout report text file at all. A failed or
  slow portable validation therefore can lose the manifest, current result
  evidence, and machine-readable timeout diagnostics before the upload step.
  This makes release-failure investigation depend on console output and can
  leave the diagnostic artifact empty while the workflow reports a real
  validation failure.
- **Confirming trace:** Source inspection showed the current manifest path is
  `${RUNTIME_DIR}/results/manifest.json` and the report is invoked with
  `$MANIFEST_FILE`; the workflow upload path remains the legacy fixed path.
  `scripts/test/ci-validation-parity-contract.test.mjs:38-70` still asserts the
  obsolete `/tmp/jest-run-manifest.json` literal and passed, demonstrating that
  the contract can validate stale documentation rather than the live retention
  path.
- **Recommended fix:** Copy or preserve sanitized per-run evidence to a stable
  upload location before the harness exits, and redirect the timeout report to
  a retained file. Update the CI upload paths, parity contract, and parity
  documentation together. Add a fixture that proves the current-run evidence
  remains available through the upload boundary.
- **Owner:** Task #1849 (Keep validation diagnostics available after CI runs).

### Finding 2 — Suite wall-clock overages can be reported as green

- **File and line:** `scripts/test-timeout-report.mjs:220-227,259-272`
- **Category:** Error handling
- **Severity:** High
- **Risk:** The report receives `wallClockMs` and `budgetMs` from each manifest
  entry, displays both values, and documents suite wall-clock violations, but
  never compares them. A current, schema-valid result with `exitCode: 0` and
  `wallClockMs` greater than `budgetMs` is classified as `PASSED`; the final
  status says all suites passed within their budgets. In a real run, process
  startup and wrapper overhead can make measured wall time exceed a child
  timeout budget even when the child exits successfully. A malformed or
  contradictory manifest can also hide the same breach.
- **Confirming trace:** A temporary valid one-test artifact with
  `wallClockMs: 999999`, `budgetMs: 1`, and `exitCode: 0` returned status 0
  and printed:

  ```text
  PASSED fixture (wall 1000.00s / budget 1ms)
  RESULT: All suites passed within their budgets.
  ```

  The existing runtime contract covers exact and over-budget individual test
  durations at `scripts/test/validation-runtime-contract.test.mjs:410-610`,
  but has no suite wall-clock overage fixture.
- **Recommended fix:** Treat a finite `wallClockMs > budgetMs` as an explicit
  suite-budget violation, preserve the distinction from a process timeout, and
  add a nonzero-result fixture with clear suite-level diagnostics.
- **Owner:** Task #1848 (Make validation suite evidence fail closed).

### Finding 3 — Missing suite identity crashes report formatting

- **File and line:** `scripts/test-timeout-report.mjs:103-116,147-159,191-215,351-358`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The report checks whether the result suite equals the manifest suite,
  but it does not require either value to be a non-empty string. When both are
  omitted, `undefined === undefined` is accepted as current evidence. The
  report then stores an undefined suite name and later dereferences
  `t.suite.length` while formatting the slow-test table. A malformed or
  mis-targeted manifest therefore produces an opaque uncaught TypeError rather
  than an explicit unavailable/invalid evidence diagnosis. The command fails
  closed in this case, but the error path is not actionable and does not
  identify the missing provenance.
- **Confirming trace:** A temporary result with one passed assertion and no
  `suite` or `validationSuite` fields printed `PASSED undefined` and
  `All suite results belong to the current validation run` before exiting 1
  with:

  ```text
  TypeError: Cannot read properties of undefined (reading 'length')
  at scripts/test-timeout-report.mjs:356:31
  ```

  Existing wrong-suite coverage at
  `scripts/test/validation-runtime-contract.test.mjs:457-513` tests unequal
  non-empty values only.
- **Recommended fix:** Require non-empty suite identity in the manifest and
  result evidence, classify omissions as unavailable or invalid before report
  construction, and add missing-identity fixtures that assert a stable
  diagnostic rather than a formatter crash.
- **Owner:** Task #1848 (Make validation suite evidence fail closed).

### Finding 4 — Heavy smoke CLI failure propagation is not contract-tested

- **File and line:** `scripts/run-protected-map-smoke.mjs:167-172`;
  `scripts/test/protected-map-timeout-contract.test.mjs:51-102`
- **Category:** Dead / unreachable code
- **Severity:** Medium
- **Risk:** The real heavy command relies on the module's CLI branch to convert
  the returned aggregate failure into process exit status 1. The focused
  contract imports and calls `runProtectedMapSmoke` directly with synthetic
  runners, so it can pass while a future edit removes or bypasses
  `process.exitCode = 1`. The heavy tier would then report success despite
  failed route children. The current behavior is correct; the gap is that the
  executable boundary is unguarded.
- **Confirming trace:** A deterministic `pnpm` shim caused all three default
  route children to exit 7. Running `node scripts/run-protected-map-smoke.mjs`
  returned exit 1 and printed owner-specific failure lines for all three
  route files. The existing timeout contract did not invoke this CLI path and
  therefore cannot catch its removal.
- **Recommended fix:** Add a child-process fixture that invokes the module's
  CLI with a deterministic failing command, asserts exit 1, and checks all
  route owners remain visible. Keep the real three-route smoke heavy-only.
- **Owner:** Task #1850 (Prove protected-map smoke failures exit nonzero).

### Finding 5 — Pending assertions are mislabeled as todo

- **File and line:** `scripts/test-timeout-report.mjs:182-189,305-306`
- **Category:** Async & timing
- **Severity:** Medium
- **Risk:** The report increments `todoCount` for statuses `todo`, `pending`,
  and `skipped`, then renders that combined value as `[N todo]`. A suite with
  an ordinary pending assertion is therefore presented as containing a todo
  assertion. The suite is correctly non-green because no assertion executed,
  so this does not create a false pass, but it misstates the evidence category
  during triage and can lead an operator to look for intentionally declared
  todos instead of skipped or pending tests.
- **Confirming trace:** A temporary all-pending result exited 1 and printed:

  ```text
  EMPTY pending (wall 1ms / budget 60.00s)  [1 todo]
  ```

  `scripts/test-result-artifact.mjs:101-132` already distinguishes todo from
  pending in its aggregate validation, but no timeout-report contract asserts
  the distinction.
- **Recommended fix:** Track todo and pending/skipped counts independently and
  render separate labels. Add pending, todo, and skipped fixtures with exact
  output assertions.
- **Owner:** Task #1848 (Make validation suite evidence fail closed).

## Verified controls and non-findings

- Host-tool declarations are checked for every registered command before the
  validation lock is entered. Missing, broken, or hanging host-tool probes are
  covered by the runtime and Port Authority contracts.
- `run-tier.mjs` is sequential and fail-fast. It reports every unrun suffix as
  `SKIPPED (fail-fast: not run)` and separates lock queue wait from post-lock
  execution time.
- The test harness preflight helper reports setup ownership, timeout status,
  child status, and `suite-started=false`. Focused fixtures covered both
  timeout and ordinary preflight failure.
- Result artifacts are schema-checked for non-negative aggregate counts,
  recognized assertion statuses, nested count consistency, and contradictory
  failure metadata. The publisher stamps the current run and suite and
  atomically renames validated output.
- Missing, corrupt, stale, wrong-suite, empty, and all-pending result evidence
  is not treated as a clean completed suite by the current timeout report.
- The protected-map runner's current timeout path owns each child deadline,
  escalates TERM-resistant descendants, preserves sibling outcomes, and reports
  the timed-out owner. Task #1446 (Run protected-map timeout cleanup in routine
  validation) and Task #1431 (Bound service smoke processes) already cover the
  implemented timeout/cleanup work; this audit does not duplicate those scopes.
- The current root watchdog targets the PID recorded for the owned child and
  recursively signals its descendants. It does not use the former
  `kill -TERM 0` pattern that would kill the watchdog itself. The normal parent
  exit trap remains able to remove the temporary runtime directory, so no
  cleanup-residue finding was promoted.

## Tooling signals

- **Repository state:** clean before and after the audit; no tracked source,
  test, workflow, or baseline changes.
- **Failure baseline:** `docs/validation/failure-baseline.json` contained an
  empty `records` array. No failure was authorized as pre-existing.
- **Required validation:** `test-heavy` was attempted exactly once with the
  task plan context and failed closed at
  `ci-validation-parity-revision-contract`. No heavier tier was run.
- **Focused contracts run independently:** validation runtime (pass),
  validation parity (pass), CI parity (pass), API suite floor (pass), and
  protected-map timeout (pass). The revision contract failed because the
  report header was stale for the checked-out revision.
- **Typecheck, lint, full dependency audit, standard, standard-plus, and the
  complete heavy tier were not independently completed after the fail-fast
  stop. Their status is unavailable, not passed.
- **Direct read-only probes:** suite wall-clock overage reproduced a false
  green; missing suite identity reproduced an opaque TypeError; pending
  evidence reproduced the incorrect todo label; and a deterministic failing
  protected-map CLI shim returned exit 1.

## Resolution ownership

| Finding | Owner | Required regression assertion | Lightest covering tier |
|---|---|---|---|
| 1 | Task #1849 (Keep validation diagnostics available after CI runs) | Current manifest/result/report files remain available through the CI upload boundary; obsolete fixed paths are rejected by the parity contract. | `test-fast` |
| 2 | Task #1848 (Make validation suite evidence fail closed) | Over-budget suite metadata returns nonzero with an explicit suite-budget diagnostic. | `test-fast` |
| 3 | Task #1848 (Make validation suite evidence fail closed) | Missing suite identity returns a classified evidence error, never an undefined formatter crash. | `test-fast` |
| 4 | Task #1850 (Prove protected-map smoke failures exit nonzero) | CLI child-process failure returns exit 1 and preserves owner-specific diagnostics for all route files. | `test-fast` |
| 5 | Task #1848 (Make validation suite evidence fail closed) | Pending, todo, and skipped fixtures produce distinct counts and labels. | `test-fast` |

The stale parity-revision stop is owned by existing Task #1820 (Refresh CI
parity evidence automatically after repository revisions), rather than a new
audit resolution task. No verified actionable finding is left without an
owner.

## Deferred / not audited

- The real three-route protected-map concurrency smoke was not reached by the
  registered heavy run. Its actual concurrent route behavior remains unobserved
  for this revision; the focused synthetic timeout contract must not be used
  as a substitute.
- No claim is made about current GitHub workflow activation, required-check
  policy, provider runs, or remote logs. Those require the explicitly excluded
  live provider inspection.
- Native map rendering and production Clerk/API authorization are outside this
  validation-test audit. The protected-map route suites use mocked Clerk/API
  behavior and React/jsdom.
- The audit did not implement any finding. Resolution tasks own changes and
  their regression validation.