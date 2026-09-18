---
name: Shared API codegen ownership
description: API client generation must use one tokenized serial resource across boot, validation, and post-merge entry points.
---

Every destructive API codegen path must acquire the shared `codegen` serial resource; lock release must validate an ownership token under the kernel guard before removing a lock.

**Why:** Separate ensure and post-merge locks permit clean-and-rewrite overlap, while PID-only cleanup can remove a successor owner's lock during stale recovery.

**How to apply:** Keep direct codegen, boot-time ensure, validation, and post-merge generation on the same resource, and include the resolved generator dependency graph in cache identity.