---
name: Serial lock kernel guard
description: Stale-holder reclaim must use a kernel-backed critical section; lease-file unlinking has a replacement race.
---

Use an OS-backed advisory lock for the short lock-file create/reclaim critical section. Do not implement stale mutex recovery by checking and unlinking a shared sidecar path: another waiter can replace it between inspection and unlink, allowing concurrent holders.

**Why:** Concurrent stale reclaimers and changing-priority waiters can invalidate a queue snapshot while a waiter is between stale-lock inspection and unlink.

**How to apply:** Keep the queue policy and lock heartbeat separate from the kernel guard; ensure the guard’s ownership is released automatically if the helper or waiter is killed, and keep recovery diagnostics in the guarded helper.