---
name: Permission-denied fixtures
description: How to exercise unreadable filesystem metadata safely in repository contract tests.
---

Use same-user mode restrictions such as `chmod 0o000` to produce `EACCES` in filesystem fixtures; do not rely on child-process UID changes, which may be blocked by the sandbox. Snapshot helpers must represent unreadable files without reading their contents.

**Why:** The validation runner may forbid `setuid`/`setgid` transitions even though the current process can create a genuinely unreadable file, and a naive snapshot can fail before the behavior under test runs.

**How to apply:** Keep the fixture owner unchanged, remove read permission only for the operation under test, and record file type plus mode when content cannot be read.