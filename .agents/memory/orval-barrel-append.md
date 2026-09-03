---
name: Orval barrel append behavior
description: Newer Orval releases can append generated barrel exports instead of replacing existing lines.
---

Normalize the managed exports in the Orval post-codegen hook rather than only checking whether a custom export exists.

**Why:** Re-running code generation after an Orval upgrade otherwise accumulates duplicate barrel exports and can make the generated workspace fail typechecking.

**How to apply:** When upgrading Orval or changing generated client outputs, make the post-codegen hook idempotent and verify two consecutive generations produce the same diff.