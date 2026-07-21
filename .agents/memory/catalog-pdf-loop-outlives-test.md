---
name: catalog-pdf background loop outlives its test
description: Cancelled job status flips before the processing loop exits; stale loops consume the next test's mocks
---
Rule: in catalog-pdf integration tests, a job's status can read "cancelled"/terminal while its background processing loop is still draining pages up to the next CANCEL_CHECK_INTERVAL boundary. The stale loop then consumes the *next* test's shared mock implementations (extractCatalogPage etc.), firing side effects (e.g. cancel POSTs) against the wrong job.

**Why:** caused intermittent full-suite-only failures where a job ended "done" instead of "cancelled" — a previous test's loop ate the mock calls that were supposed to trigger cancellation.

**How to apply:** embed a per-test tag in fake page text (`makeFakePages(count, tag)`) and have mock implementations ignore calls whose page text lacks the tag; count assertions must filter calls by tag too.
