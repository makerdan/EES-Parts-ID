---
name: pipefail echo|grep -q flake
description: Why static-content grep checks in bash test suites fail nondeterministically under set -o pipefail
---
Under `set -o pipefail`, checks of the form `echo "$BIG_VAR" | grep -q pattern` can fail spuriously: `grep -q` exits at the first match, and if `echo` is still writing (pipe buffers can shrink to 4KB under system pipe-page pressure from concurrent background processes), echo dies with SIGPIPE and the pipeline reports failure even though the pattern is present.

**Why:** The post-merge health test suite showed nondeterministic FAILs on viewbox-sync/verify-fts/pnpm-install static checks that greened on retry; root cause was this SIGPIPE + pipefail interaction, aggravated by orphaned test runs loading the box.

**How to apply:** In bash test suites with pipefail, never pipe a variable into `grep -q`; grep the source file directly (`grep -q pattern "$file"`) or use `<<<`. Also: killed test runs leave orphaned post-merge.sh/pnpm children that skew later runs — clean strays before diagnosing "flaky" suites.
