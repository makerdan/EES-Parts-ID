---
name: Startup unref timer tests
description: Jest fake timers can be unreliable for unref’d timers in dynamically imported startup modules.
---

When testing startup deadlines, avoid depending solely on Jest fake timers to observe
unref’d timers created after a dynamic import. Prefer deterministic deferred promises
and explicit terminal-readiness state assertions; exercise elapsed timeout budgets in
an isolated helper test when needed.

**Why:** The fake clock advanced and reported pending timers, but the unref’d global
startup callback did not run reliably in the startup integration harness.

**How to apply:** Synchronize tests on the relevant startup step, then assert that a
late completion cannot transition readiness after `timed_out` or `failed`.