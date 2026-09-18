# Bug & Error Audit Report

**Scope:** Validation serialization, lock ownership and recovery, port authority,
timeout and watchdog handling, process cleanup, and result-manifest reporting in
the repository's validation runtime controls.
**Mode:** report-only
**Date:** 2026-09-15
**Stack:** Node.js 24 ESM scripts, Bash, `flock`, `/proc` process and socket
inspection, Jest/Vitest JSON output. React-specific categories were not
applicable to this tooling scope. The typed-language category was checked
through the fast-tier TypeScript validation, but the audited runtime-control
files are JavaScript and shell.

## Architecture and lifecycle map

### Validation lock and tier execution

`package.json` starts each validation tier through `serial-lock.mjs` on the
`validation` resource. The wrapper performs host-tool preflight, records a
queue entry, checks priority ordering, and asks `flock` to guard lock-file
creation or stale recovery through `serial-lock-critical.mjs`. A successful
acquisition creates a four-line lock file containing the holder PID, acquire
time, priority, and Linux process-start tick. The wrapper refreshes the lock
mtime while the child runs, exports reentrancy state, optionally starts a
post-acquisition budget timer, and removes the lock when the child exits.

`run-tier.mjs` then executes the registered tier steps synchronously and
fail-fast. Each step is a `bash -c` child; the tier summary separates queue
wait from execution time. The standard test step adds `DATABASE_ENV=test`
only to its child environment.

### Stale-lock and queue recovery

Waiting wrappers inspect dead or reused PIDs, stale heartbeat mtimes, and the
maximum hold age. A critical helper performs the lock-file create/reclaim
operation under the kernel guard. Queue entries are published through a
temporary file and rename, then removed by PID on completion. Forced
reclaims emit warnings.

Normal completion removes the queue entry and lock. A wrapper signal handler
tries to signal its direct child and releases the lock. A killed wrapper loses
the `flock` guard automatically; later waiters can reclaim the lock file.
The max-hold path is different: it removes a lock whose holder can still be
alive and running.

### Port authority

`dev-ports.json` is the source of workflow, fallback, legacy, and cleanup
ports. `dev-port-contract.mjs` compares it with `.replit` and artifact
manifests. `free-dev-ports.mjs` delegates to `free-ports.mjs`, which discovers
LISTEN sockets through `/proc`, climbs known Node/package-manager/shell
wrappers, protects its own ancestor tree, sends SIGTERM, escalates to
SIGKILL, and confirms that each requested port is free.

### Suite timeout, watchdog, and result publication

`test-all.sh` serializes the three-suite run on `shared-test-results`, runs
each suite through GNU `timeout --kill-after=15s`, stores JSON files under
fixed `/tmp/jest-results-*.json` paths, and writes one fixed
`/tmp/jest-run-manifest.json` after the suite loop. A background watchdog
attempts a process-group SIGTERM at 18 minutes and then a process-group
SIGKILL after 15 seconds. `test-timeout-report.mjs` reads the manifest and
JSON files, summarizes suite exit codes, lists slow tests, and returns
nonzero for failed or timed-out suites.

### Lifecycle review matrix

| Path | Lock / process behavior | Result behavior |
|---|---|---|
| Normal completion | Child exit releases the lock and queue entry; tier continues or reports the step result. | Manifest is written after all suites; report uses exit codes and whatever JSON exists. |
| Wrapper cancellation | Signal handler signals only the direct child, releases the lock, and exits 1. | A partial suite may have no new JSON; the report is only reached if the outer shell survives. |
| Child crash | Direct child exit releases the lock and propagates nonzero status. | A failed suite is represented in the final manifest if the loop continues. |
| Budget timeout | Wrapper sends SIGTERM and later SIGKILL only to its direct child; lock release follows direct-child exit. | A child that exits zero after SIGTERM can be reported as success. |
| Stale-lock reclaim | Kernel guard serializes reclaimers, but max-hold reclaim can remove a live holder's lock. | A reclaimed holder can continue after a later holder starts. |
| Outer watchdog timeout | `kill -TERM 0` targets the watchdog's process group, including the watchdog itself. | The report/manifest may never be produced, and TERM-ignoring descendants can remain. |

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 3 |
| Medium | 3 |
| Low | 0 |

| # | Severity | Category | File:Line | One-line description |
|---:|---|---|---|---|
| 1 | High | Concurrency & shared state | `scripts/serial-lock-critical.mjs:76-86` | Max-hold recovery can release a live holder's lock and allow overlapping serialized work. |
| 2 | High | Async & timing | `scripts/serial-lock.mjs:445-464` | Budget escalation signals only the direct child, leaving descendants running after lock release. |
| 3 | High | Async & timing | `scripts/test-all.sh:73-83` | The watchdog can terminate itself with `kill -TERM 0` before its SIGKILL escalation. |
| 4 | Medium | Error handling | `scripts/serial-lock.mjs:445-464` | A child that exits zero after budget SIGTERM makes the timed-out wrapper exit zero. |
| 5 | Medium | Error handling | `scripts/test-timeout-report.mjs:161-175` | A passed individual test over its declared budget does not make the report fail. |
| 6 | Medium | State & data integrity | `scripts/test-all.sh:62-66,98` and `scripts/test-timeout-report.mjs:89-101` | Fixed or missing result files can make the report use stale data or claim success without evidence. |

## Findings

### Finding 1 — Max-hold recovery can overlap a live serialized step

- **File and line:** `scripts/serial-lock-critical.mjs:76-86`
- **Category:** Concurrency & shared state
- **Severity:** High
- **Risk:** The helper treats any lock older than `MAX_HOLD_MS` as reclaimable and unlinks it even when the holder PID is alive and its heartbeat is current. A legitimate validation step that runs beyond the two-hour default, or a step whose event loop is delayed while still doing work, can therefore continue running after a waiter acquires the same resource. The old and new steps can concurrently regenerate files, write shared test results, bind ports, or mutate the same database fixtures, defeating the serialization guarantee. The helper's warning makes the event visible, but does not prevent the overlap. This is a verified control-flow issue; the existing contract test covers recovery logging, not continued holder execution after a live max-hold reclaim.
- **Recommended fix:** Make max-hold recovery fail closed or require an explicit owner-side termination/lease-expiry protocol before allowing a new owner. At minimum, distinguish a live holder from a dead holder, terminate and confirm the holder's complete process tree, and add a bounded interleaving test proving that no new child starts until the previous holder has exited.

### Finding 2 — Budget escalation leaves descendant processes alive

- **File and line:** `scripts/serial-lock.mjs:445-464`
- **Category:** Async & timing
- **Severity:** High
- **Risk:** The budget timer calls `child.kill("SIGTERM")` and then `child.kill("SIGKILL")` on only the direct child created by `spawn()`. It does not create or signal a process group/tree. A direct child that has spawned a Jest worker, server, shell, or other descendant can die while that descendant continues running. The wrapper then releases the resource lock and exits, allowing another serialized step to run concurrently with the orphan. A bounded probe spawned a grandchild, triggered a 100 ms budget, observed wrapper exit 1, and confirmed the grandchild was still alive afterward.
- **Recommended fix:** Run wrapped commands in a dedicated process group or use a tree-aware termination routine, signal the group on both escalation stages, wait for descendants to exit, and only release the lock after cleanup is confirmed. Add a regression test with a descendant that ignores the first signal.

### Finding 3 — The outer watchdog can kill itself before SIGKILL escalation

- **File and line:** `scripts/test-all.sh:73-83`
- **Category:** Async & timing
- **Severity:** High
- **Risk:** The watchdog runs in the same process group as the script and executes `kill -TERM 0`. That signal targets the entire group, including the watchdog subshell itself. The watchdog therefore normally cannot reach its following 15-second sleep and SIGKILL command. If a suite runner or descendant ignores SIGTERM, the intended hard stop does not happen: the parent can exit while the descendant remains alive, retaining ports, sockets, database connections, or CPU. A bounded process-group probe reproduced the behavior: the “watchdog-fired” marker appeared, “escalation-fired” did not, and a TERM-ignoring child remained alive.
- **Recommended fix:** Put the watchdog and workload in deliberately separate process groups, or have a supervisor outside the target group perform the escalation. Record the watchdog's terminal reason and add a test that keeps a child alive after SIGTERM and asserts that the SIGKILL stage terminates it.

### Finding 4 — A graceful budget response can be misclassified as success

- **File and line:** `scripts/serial-lock.mjs:445-464`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The budget callback logs an error but does not set a timeout-failure flag. If the child handles SIGTERM and exits with code 0, the `exit` handler propagates that zero status and the wrapper reports success despite the budget breach. A bounded probe with a child that exits zero from its SIGTERM handler produced wrapper exit 0 alongside the “budget exceeded” error. A validation tier can consequently be marked passed even though its runtime contract was violated.
- **Recommended fix:** Record that the budget fired and force a distinct nonzero timeout result regardless of the child's eventual exit code. Preserve the timeout reason in the tier summary and manifest so callers cannot mistake a graceful timeout exit for a pass.

### Finding 5 — Passed tests over their declared budget are not violations

- **File and line:** `scripts/test-timeout-report.mjs:161-175`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The report calculates and displays a per-test budget delta, but `timedOutTests` contains only tests whose failure messages contain timeout wording. A test with a duration greater than its 10-second (or 20-second integration) budget can remain `passed`, leave `hasViolations` false, and produce `RESULT: All suites passed within their budgets.` A bounded fixture with an 11-second passed test and a 10-second suite budget returned exit 0 and that success message while displaying `+1.00s`. This makes the result misleading for the exact budget-breach condition the report claims to detect.
- **Recommended fix:** Treat a completed test with `duration > testBudgetMs` as a budget violation, label it separately from a framework timeout, and make the final result nonzero. Add fixtures for both a normal test and an integration test crossing their respective thresholds.

### Finding 6 — Result files can be stale or absent without a diagnostic

- **File and line:** `scripts/test-all.sh:62-66,98` and `scripts/test-timeout-report.mjs:89-101`
- **Category:** State & data integrity
- **Severity:** Medium
- **Risk:** `test-all.sh` reuses fixed `/tmp/jest-results-<suite>.json` paths and does not remove or truncate each file before starting a suite. If a runner times out or crashes before writing a new JSON file, the report can parse a previous run's results as if they belonged to the current manifest. A bounded fixture showed an old test name appearing in a current failed-run report. Conversely, if the file is missing or corrupt, the parser silently sets `jestData` to null; a suite with exit code 0 is then reported as passed with “no timing data available” and the final result still says all suites passed. This weakens diagnostics precisely when result publication is incomplete.
- **Recommended fix:** Create a per-run temporary result directory and clear/atomically publish each suite result, include a run identifier in the manifest, and reject missing or corrupt JSON for any suite that claims success. Emit an explicit “result unavailable” status rather than silently treating absent evidence as a clean report.

## Ten-category audit coverage

- **Null / undefined safety:** Reviewed lock metadata parsing, manifest fields, and JSON result access. The verified result-publication finding is recorded above; no additional null dereference was confirmed.
- **Async & timing:** Reviewed heartbeats, polling, budget timers, signal escalation, watchdog timers, and port-free waits. Findings 2 and 3 were verified here.
- **Error handling:** Reviewed child exit propagation, timeout status, corrupt result handling, and fail-fast tier reporting. Findings 4 and 5 were verified here.
- **Type safety:** The runtime-control implementation is JavaScript and shell; the repository's fast-tier TypeScript checks passed. No separate typed-runtime finding was confirmed.
- **State & data integrity:** Reviewed lock ownership, queue publication, fixed result paths, and manifest generation. Finding 6 was verified here.
- **Security:** Reviewed process selection boundaries, production/guard no-op paths, and hardcoded-port checks. No additional security vulnerability was confirmed in the scoped tooling.
- **Performance:** Reviewed polling, `/proc` scans, sequential port cleanup, and watchdog budgets. No separate performance defect was confirmed beyond the timeout and process-lifecycle findings.
- **Concurrency & shared state:** Reviewed kernel guard usage, priority queue snapshots, stale reclaim, shared results, and nested resources. Finding 1 was verified here.
- **Dead / unreachable code:** No separate dead-code finding was confirmed from the scoped scripts.
- **Dependency hygiene:** The fast-tier dependency and patched-dependency contract checks passed. A full dependency vulnerability audit was outside the task's locked validation command.

## Tooling signals (Phase 0 and acceptance)

- **Typecheck:** Clean in the fast tier (`tsc` step passed).
- **Lint:** Clean in the fast tier (`lint`, `lint-mocks`, and `tsconfig-check` passed).
- **Tests / contracts:** `pnpm run test-fast` passed all 27 registered steps. The Port Authority contract reported 19 passed and 0 failed checks.
- **Dependency signals:** `dependency-security-contract` and `patched-dependencies` checks passed. No heavier audit was run because the task explicitly locked validation to `pnpm run test-fast`.
- **Bounded probes:** Confirmed the live max-hold overlap path, descendant survival after budget escalation, watchdog self-termination before escalation, graceful budget misclassification, passed-test budget omission, and stale/missing result behavior. Temporary probe files were removed.

## Deferred / not audited

- No runtime-control tooling was changed. All six findings are report-only and require explicit follow-up approval before fixes.
- The task did not stress-run the standard, standard-plus, or heavy validation tiers.
- Application-level concurrency, database transaction behavior, and dev-server application logic were out of scope.
- The port cleanup implementation was reviewed for process-tree races and PID identity windows; no additional issue was promoted without a deterministic reproduction. The existing contract passed, but it does not stress concurrent cleanup against PID reuse or a process that spawns descendants during the kill snapshot.