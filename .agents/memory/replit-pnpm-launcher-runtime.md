---
name: Replit pnpm launcher runtime
description: Replit can expose a current Node executable while the packaged pnpm launcher has an older Node interpreter in its shebang.
---

The Node process launched directly from PATH can differ from the Node interpreter
that runs the Replit-provided pnpm executable. Treat the runtime used by
validation child commands as the contract boundary, and do not interpret pnpm's
own engine warning as proof that the child `node` executable is wrong.

**Why:** The workspace exposed Node 24.13.0 on PATH while the pnpm launcher was
packaged with a Node 24.12.0 shebang, producing engine warnings during otherwise
correct validation.

**How to apply:** Keep an explicit runtime check in the validation tier that
compares the active child process with both `package.json` `engines.node` and
`.node-version`; use the diagnostic to distinguish an actual runtime mismatch
from a stale package-manager launcher.

The package engine declaration should be a bounded range that includes the
launcher’s compatible patch, while `.node-version` remains the exact patch
used by validation and GitHub.

**Why:** An exact package engine can make pnpm emit an unsupported-engine warning
for its own older interpreter even when the child `node` process is the pinned
version and all application checks are correct.

**How to apply:** Keep the lower bound within the supported Node major, cap the
range before the next major, and have the runtime checker verify both the range
and the exact `.node-version`/active-process match.