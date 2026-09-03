---
name: SVG load singleton retries
description: Prevent dead module-level floor-plan load promises from suppressing later cold or retry loads.
---

If the shared floor-plan load promise has settled, reuse it only when the current
cache entry is renderable for the active platform. An empty or missing entry must
clear the settled promise and start a fresh load on both web and native.

**Why:** A failed or stale load can leave a resolved singleton behind; returning
that promise makes later mounts appear loaded without ever receiving SVG data.

**How to apply:** Keep the settled-promise fast path coupled to the same
platform-aware renderability predicate used by the component's loading state and
retry logic.