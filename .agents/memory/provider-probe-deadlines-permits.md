---
name: Provider probe deadlines and permits
description: How bounded provider verification preserves both response deadlines and real transport concurrency.
---

Return an operation-level budget-limited result at the aggregate deadline, but do not release a concurrency permit until the underlying provider transport actually settles. Queued verification must be cancellation-aware and expire without dispatch when capacity remains occupied.

**Why:** Releasing a permit when only the response deadline wins allows an abort-ignoring transport to remain active while new requests start, silently exceeding the real provider concurrency ceiling. Waiting for stuck transports instead makes administrator endpoints hang and can grow an unbounded queue.

**How to apply:** For any explicit live-provider probe, separate response ownership from transport ownership. Publish partial results on time, retain transport permits through settlement, bound queue waits, and test with a transport promise that ignores abort.