---
name: Validation runtime controls
description: Durable audit lessons for serialization timeout, watchdog, process cleanup, and result evidence.
---

Validation serialization is only trustworthy when timeout and watchdog escalation terminate the complete owned process tree, live-holder recovery cannot overlap work, and result publication is treated as required evidence rather than optional diagnostics.

**Why:** A direct-child timeout can leave descendants running after the lock is released; a live max-hold reclaim can start a second holder; a process-group watchdog can terminate its own escalation stage; and stale or missing JSON can make a report look clean.

**How to apply:** For future validation-control changes, test normal completion, cancellation, crash, timeout, signal-ignoring descendants, live max-hold expiry, and missing/corrupt/stale result files. Force timeout outcomes nonzero and fail closed when result evidence is absent.