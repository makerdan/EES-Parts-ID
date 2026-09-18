---
name: Exact-tree GitHub snapshot transport
description: Safe fallback for publishing a tracked workspace snapshot without exposing local Git history.
---

When GitHub Git Data blob uploads through a connector are blocked by an
intermediary, do not loosen repository policy or fall back to pushing the local
branch history. Build the snapshot in a temporary shallow clone of the latest
remote default branch, replace only its worktree with the tracked workspace
snapshot, and push the resulting child commit to a review branch.

**Why:** Raw blob API requests can receive an intermediary 403 even when normal
repository reads and writes are authorized. A shallow-clone fallback preserves
the required parentage while preventing local commits, reflogs, ignored files,
and historical objects from reaching the remote.

**How to apply:** Use a temporary credential helper that reads the existing
credential from the environment without printing it. Before pushing, compare
the staged snapshot tree SHA with the source workspace tree SHA. Push only to a
new or existing review branch, verify the remote ref, then remove the temporary
clone and helper.