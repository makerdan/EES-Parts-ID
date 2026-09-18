---
name: API health restart recovery
description: Restart recovery must preserve user-visible outcomes while refreshing the complete health snapshot.
---

Terminal restart outcomes belong to the shared health state, not to a one-shot alert. Focus, background, and unmount cleanup must stop active work without erasing a result that can still guide the admin. A successful recovery response must update both the overall API status and its bot snapshot so stale probe chips do not survive recovery.

**Why:** An accepted restart can finish after navigation or with delayed health availability; clearing state during cleanup made failed recovery silent, while updating only the top-level status left dependent health indicators stale.

**How to apply:** When changing `useApiStatus`, keep terminal restart notices dismissible or clearable only after a confirmed health check, and treat recovery payloads as complete health snapshots.