---
name: Workflow stop during startup
description: Workflow stop can race with a pending startup, so verify the state again after a short delay.
---

Stopping a workflow while it is reported as `not_started` can return success even when an already-pending startup subsequently moves it to `running`. Recheck the workflow state and its port after a short delay, then stop the named workflow again if it is running.

**Why:** In an operational pause, the three development workflows were initially `not_started`, each stop returned success, but a pending startup later showed all three `running`. A second stop left them `finished` with no listeners.

**How to apply:** For workflow pauses, confirm stopped state and idle ports after a delay rather than treating a successful stop response as final evidence. Do not kill child listeners as a substitute for stopping the supervisor.