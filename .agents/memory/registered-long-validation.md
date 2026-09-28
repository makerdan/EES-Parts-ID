---
name: Registered long validation observation
description: A registered validation observer cannot extend the service's roughly ten-minute lifetime.
---

Long-running registered validation can use a detached, separately monitored execution, but the service's initial result must be nonzero and explicitly pending if the underlying command has not finished. The later terminal result is authoritative only through the run's persisted status and log; a pending or stopped service result must never be called a pass.

**Why:** The service observation window is shorter than normal standard-tier execution and has no documented extension setting. Reporting success on launch would silently disable the validation gate. The user chose separately monitored terminal evidence over attempts to shorten checks to fit the window.

**How to apply:** For a long validation run, retain its run ID and inspect its terminal evidence after the worker finishes. Keep the post-lock execution budget and queue-wait accounting in the underlying command, and never infer success from an observer that returned pending.