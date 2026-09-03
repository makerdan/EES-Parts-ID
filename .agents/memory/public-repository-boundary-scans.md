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