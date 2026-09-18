---
name: GitHub pull refs survive branch rewrites
description: Complete public-history verification must account for GitHub-retained pull-request refs that normal clones omit.
---

A clean scan of every public branch head does not prove that GitHub no longer
serves rejected historical objects. A mirror fetch can include read-only
`refs/pull/*` refs that a normal clone omits, and those refs may retain commits
removed from all branch histories.

**Why:** After an exact-lease rewrite made every public branch head clean, a
normal full clone reported no rejected historical path categories while a
mirror of the same repository still found the original rejected paths only
through GitHub-retained pull-request refs.

**How to apply:** Use a mirror fetch for the final provider-exposure scan.
Classify branch heads separately from `refs/pull/*`. Normal Git and GitHub API
clients cannot delete or force-update pull-request refs; require provider-side
removal or an explicitly approved repository replacement before claiming the
entire public GitHub history is purged.