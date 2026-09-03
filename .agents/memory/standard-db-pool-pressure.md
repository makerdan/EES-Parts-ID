---
name: Standard-tier database pool pressure
description: How to classify API integration failures caused by concurrent standard validation.
---

Concurrent standard-tier validation can exhaust the shared PostgreSQL connection limit, producing `53300` / “too many clients already” failures in otherwise healthy API integration tests.

**Why:** The affected inventory integration suite passes repeatedly when run alone with Jest in-band, while the full standard tier runs multiple package suites concurrently.

**How to apply:** If the standard tier fails with this database error, verify the named API suite in isolation three times before attributing the failure to the current change; do not broaden validation beyond the assigned tier.