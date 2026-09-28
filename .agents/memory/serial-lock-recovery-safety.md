---
name: Serial-lock recovery ownership
description: Non-obvious invariants for reclaiming crashed or stale serial-lock holders safely
---

Stale recovery must read the lock's token, worker PID, and worker start ticks while holding the same kernel guard used for acquisition and release. A stale waiter must terminate and confirm the registered worker group before unlinking ownership, and token-mismatched release or heartbeat operations must fail closed.

The holder's own queue entry must not block stale recovery. Queue precedence should ignore the PID currently recorded as the lock holder; otherwise a crashed or stale holder can leave its queue record behind and prevent the only waiter able to reclaim it from reaching the reclaim path.

Dead or PID-reused queue entries should be removed immediately during precedence inspection, not retained until the stale-heartbeat timeout. A crashed holder's orphaned queue record can otherwise remain an older peer and strand every successor after the lock itself is reclaimed.

Detached workers must not inherit caller-facing output pipes. Relay output with backpressure, and wait for both worker streams and queued relay writes to drain before reporting a normal exit. Killing the wrapper must still close its caller-facing descriptors immediately.

**Why:** A detached wrapper can disappear while its child keeps running, and release failure can leave the lock file behind. Treating the lock file or queue as independent state either permits overlap or deadlocks recovery.

**How to apply:** When changing serial-lock metadata, output forwarding, process-group cleanup, token checks, or queue ordering, preserve guarded metadata reads, PID/start-tick identity checks, successor-token protection, and recovery tests that exercise wrapper loss, stalled output readers, and stale heartbeats.