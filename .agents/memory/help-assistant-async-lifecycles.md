---
name: Help assistant async lifecycles
description: Independent Help content and assistant requests need separate cancellation and generation ownership.
---

Each asynchronous Help lifecycle must own its controller and generation token. Content refreshes, identity changes, explicit assistant cancellation, and assistant retries must not leave a request stuck in a loading state or allow a stale answer to overwrite newer context.

**Why:** Sharing cancellation state across the Help content loader and assistant made an unrelated refresh able to abort or invalidate an in-flight question without restoring a stable UI state.

**How to apply:** When adding Help-side async work, keep cancellation and stale-result checks local to that lifecycle; on user cancellation, transition out of loading immediately while preserving completed conversation turns.