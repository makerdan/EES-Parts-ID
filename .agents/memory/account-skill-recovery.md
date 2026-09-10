---
name: Account skill projection recovery
description: Recovery validates preserved projection backups by their own manifest and bytes before atomic restoration.
---

Recovery of a preserved account-skill projection must validate the backup's
recorded manifest, complete file set, and fingerprints without requiring its
revision to match a newer canonical source revision.

**Why:** A preserved backup is the last-known-good projection from a failed
refresh, so the source may have advanced after the backup was created. Requiring
current-source parity would reject the exact artifact recovery is meant to
restore.

**How to apply:** Discover only exact owned backup names under the projection
parent, reject symlinked or ambiguous candidates, restore under the projection
lock, and defer removal of stale owned backups until a later refresh succeeds.