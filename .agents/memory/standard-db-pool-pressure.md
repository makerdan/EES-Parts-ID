---
name: Standard-tier database pool pressure
description: How to classify API integration failures caused by concurrent standard validation.
---

Concurrent standard-tier validation can exhaust the shared PostgreSQL connection limit, producing `53300` / “too many clients already” failures in otherwise healthy API integration tests.

**Why:** The affected inventory integration suite passes repeatedly when run alone with Jest in-band, while the full standard tier runs multiple package suites concurrently.

**How to apply:** If the standard tier fails with this database error, verify the named API suite in isolation three times before attributing the failure to the current change; do not broaden validation beyond the assigned tier.

Static cache warmers are part of this pressure budget: avoid fan-out queries that each acquire a pool client during concurrent validation. Prefer one transaction/client with bounded in-request retry, while keeping persistent failures explicit.

**Why:** A cache initializer can turn a single request into several simultaneous connections and fail before the actual business query runs, making an otherwise healthy integration contract appear broken.

**How to apply:** When a cache warmup touches multiple database tables, account for its peak client usage separately from the steady-state request pool and test one transient acquisition failure deterministically.