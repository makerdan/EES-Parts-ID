---
name: Public repository boundary scans
description: Durable implementation constraints for repository privacy guards
---

Repository-boundary scanners should distinguish real credential/data exposure
from test controls, generated bundles, package metadata, and source identifiers
such as storage keys. The scanner’s own file commonly contains deliberately
unsafe negative-control strings, so its live-tree content must be excluded
while its path remains checked. Reachable-history path listings can exceed
Node’s default child-process buffer and need an explicit bounded buffer.

**Why:** A broad regex produced false positives in normal tests, cache-key
constants, dependency metadata, and the scanner itself; the first complete
history listing also failed before producing a result.

**How to apply:** Keep checks narrowly focused on known credential formats,
synthetic test allowlists, and prohibited path classes. Use clearly synthetic
`test-*` values in credential-shaped fixtures because test files are still
scanned. Report historical private paths for owner-led purge rather than
treating current-tree deletion as history remediation.

Release validation must also prove that the checkout contains the complete
history/ref set being claimed and that provider protection evidence is bound to
the exact revision under review; path-only history results and dated prose
markers are not release proof.

**Why:** A shallow CI checkout can make `rev-list --all` appear clean while
omitting older objects, and a checked-in protection snapshot can remain marked
verified after the repository revision changes.

**How to apply:** Fail closed on shallow/incomplete history before reporting
cleanliness, and compare repository, target SHA, policy, and permission context
when consuming retained provider evidence.