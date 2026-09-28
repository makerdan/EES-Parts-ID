---
name: Release lock-order fixtures
description: How local release tests prove revision reads occur only after coordination-lock acquisition
---

Use a test-only Git shim that delegates to the real executable and records
whether the lock file exists when a `HEAD^{commit}` read succeeds. A successful
locked command must record only post-lock reads; a lock-acquisition timeout must
record no reads and publish no evidence.

**Why:** A command can appear to use the lock while a future wrapper refactor
still captures mutable workspace state before entering the serialized section.

**How to apply:** Keep the fixture local to the repository boundary test and
observe lock-file visibility rather than invoking provider APIs or relying on
timing-sensitive sleeps.

Locked verification fixtures must distinguish the initial workspace-revision
capture from the later final revision read. A cross-process read counter should
trigger the external ref move only after the capture, or the test will stop at
an earlier stale/tree check instead of proving final identity protection.

**Why:** The release-facing wrapper captures `HEAD` before the inner verifier
performs its normal checks, while each Git shim invocation runs in a fresh
process.

**How to apply:** When testing a workspace mutation under `--locked-verify`,
delay the shim’s ref update until the second matching `HEAD^{commit}` read and
assert both fail-closed output and absence of the release record.