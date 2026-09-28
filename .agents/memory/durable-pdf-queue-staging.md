---
name: Durable PDF queue staging
description: Why completed catalog upload parts must survive while a PDF job waits in memory
---

Keep the durable upload's staged parts until a worker actually claims the PDF job, not merely until a bounded in-memory queue admits it.

**Why:** Queue admission only retains bytes in process memory. A restart between admission and worker claim discards the buffer; deleting staged parts at admission makes the completed session unrecoverable.

**How to apply:** When changing catalog worker scheduling or upload completion, distinguish queued from claimed jobs. Preserve staged parts through the waiting period, then clean them up after a worker has taken ownership. Ensure retry/reconciliation does not schedule the same queued job twice.