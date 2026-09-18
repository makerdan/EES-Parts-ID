---
name: Validation runtime controls
description: Durable audit lessons for serialization timeout, watchdog, process cleanup, and result evidence.
---

Validation serialization is only trustworthy when timeout and watchdog escalation terminate the complete owned process tree, live-holder recovery cannot overlap work, and result publication is treated as required evidence rather than optional diagnostics.

**Why:** A direct-child timeout can leave descendants running after the lock is released; a live max-hold reclaim can start a second holder; a process-group watchdog can terminate its own escalation stage; and stale or missing JSON can make a report look clean.

**How to apply:** For future validation-control changes, test normal completion, cancellation, crash, timeout, signal-ignoring descendants, live max-hold expiry, and missing/corrupt/stale result files. Force timeout outcomes nonzero and fail closed when result evidence is absent.

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