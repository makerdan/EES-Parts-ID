---
name: DB fixture ownership watermarks
description: How to identify asynchronously inserted shared-database test fixtures without depending on synchronized clocks.
---

For async integration-test inserts, snapshot the table's highest database-generated ID before the request, then identify the owned row with a unique fixture discriminator and an ID above that watermark.

**Why:** Application and database clocks can differ enough for a newly inserted row's database timestamp to fall before an application-side `new Date()` cutoff, causing intermittent lookup failures and leaked fixtures.

**How to apply:** Use this when the route inserts asynchronously and does not return the inserted ID. Combine the watermark with a worker-specific unique value; do not treat the watermark alone as ownership under concurrent tests.