---
name: catalog-pdf background loop termination
description: How to keep cancelled catalog-pdf background loops from outliving tests or burning AI calls
---
Rule: catalog-pdf background page-processing loops check cancellation before every page (CANCEL_CHECK_INTERVAL=1) and register themselves in an in-module registry; tests must `await awaitJobTermination(jobId)` (exported from the catalog-pdf route) after job status reads terminal, before asserting on shared mocks.

**Why:** job status flips to "cancelled" while the loop is still finishing the in-flight page; historically (interval=10) stale loops drained up to 9 extra pages, consumed the *next* test's mock implementations, and spent AI calls after cancel. Per-test tag-filtering of mocks was the old workaround — no longer needed.

**How to apply:** in catalog-pdf integration tests, call `awaitJobTermination(jobId)` after `waitForJobTerminal` and before any mock-call-count assertions. In route code, any new background loop launched via setImmediate must be wrapped with `trackJobLoop(jobId, promise)` so termination stays awaitable.
