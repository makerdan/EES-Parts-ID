---
name: Validation runtime controls
description: Durable audit lessons for serialization timeout, watchdog, process cleanup, and result evidence.
---

Validation serialization is only trustworthy when timeout and watchdog escalation terminate the complete owned process tree, live-holder recovery cannot overlap work, and result publication is treated as required evidence rather than optional diagnostics.

**Why:** A direct-child timeout can leave descendants running after the lock is released; a live max-hold reclaim can start a second holder; a process-group watchdog can terminate its own escalation stage; and stale or missing JSON can make a report look clean.

**How to apply:** For future validation-control changes, test normal completion, cancellation, crash, timeout, signal-ignoring descendants, live max-hold expiry, and missing/corrupt/stale result files. Force timeout outcomes nonzero and fail closed when result evidence is absent.

Nested serialized commands are reentrant only when the inner wrapper names the same resource as its ancestor.

**Why:** A package test wrapper using the default global resource can queue behind a root harness holding shared-test-results, turning a valid standard run into a self-deadlock instead of exercising its completion evidence.

**How to apply:** When a validation harness wraps package scripts, pass the ancestor’s explicit resource and priority through every nested serialization boundary, then cover the package script contract.

Smoke harnesses that own HTTP servers must track their sockets and bound shutdown as well as bound requests; `server.close()` waits on keep-alive or stalled connections and can otherwise strand the next validation step.

**Why:** A stalled proxy fixture kept the stub server open after the client request timed out, so graceful close alone was not enough to guarantee cleanup.

**How to apply:** Add an absolute request deadline, destroy the request on timeout, and force-close tracked sockets from an outer cleanup path with its own deadline.

Shell helpers that wait for owned child processes must capture `wait` failures without
temporarily enabling `errexit`; otherwise a nonzero child can terminate the caller
before the phase-specific status classifier runs.

**Why:** A preflight child exiting with an ordinary failure code bypassed its
caller’s diagnostic branch when the helper restored `set -e` before returning.

**How to apply:** Use a conditional `wait ... || exit_code=$?` and leave errexit
ownership with the caller, which can then distinguish ordinary failures from timeouts.

Watchdog cleanup must terminate the watchdog’s descendant timer processes, not
only the background subshell, because descendants can keep captured stdout or
stderr open after the harness has already classified a failure.

**Why:** An ordinary preflight failure returned promptly but its long-lived
watchdog sleep kept the parent’s output pipe open until the watchdog budget expired.

**How to apply:** Reuse the harness process-tree terminator from the normal exit
trap before removing runtime state.

Process-group cleanup on Linux must treat zombie members as terminated when
checking whether an owned group is gone; `kill(-pgid, 0)` can continue to
report a group containing only unreaped zombies as alive.

**Why:** Waiting on the signal probe alone can keep a timed-out wrapper alive
after SIGKILL has already terminated every runnable descendant.

**How to apply:** Inspect `/proc/<pid>/stat` process-group and state fields
before deciding that a killed validation group still owns runnable work.

Registered validation polling includes time spent waiting for the serialization
lock, not just tier execution time.

**Why:** A fast run queued for several minutes passed its changed contract step,
but the validation service stopped polling before the entire tier completed.
The same selected tier passed when run after the lock cleared.

**How to apply:** For a poll-budget error, inspect the run's actual terminal
status, queue-wait time, and log before assigning a test failure. If the queue
consumed the polling window, retry only the originally selected tier when the
lock is clear; do not escalate to another tier.

Development-port checks in this workspace cannot assume `ss` or
`/proc/net/tcp6` is available.

**Why:** Both were absent during a workflow-pause verification, so a piped
socket command initially appeared to show no listeners without proving it.

**How to apply:** Check workflow states and inspect `/proc/net/tcp` for
listening sockets (state `0A`); inspect `/proc/net/tcp6` only if present. Make
the probe fail on unexpected read errors instead of treating them as no ports.