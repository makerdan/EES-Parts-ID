---
name: Bulk enrichment restart state
description: Durable status semantics for bulk enrichment outcomes across API restarts.
---

Persisted bulk-enrichment rows represent history, not resumable workers. A restart-style status read may restore only the newest terminal outcome (`completed`, `cancelled`, or `failed`); stale `running` and `stopping` rows must not become an active in-memory job.

**Why:** The worker is process-local and cannot safely be resumed from a row that may belong to a dead process. Restoring it as active would mislead administrators and expose a stop request that is no longer being acted on.

**How to apply:** Keep terminal result fields durable, clear stop-in-progress state when the worker reaches any terminal outcome, and await terminal persistence before the worker promise resolves.