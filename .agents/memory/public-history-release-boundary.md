---
name: Public history release boundary
description: Release-scan behavior for reachable Git history and privacy-safe remediation output.
---

The tracked-tree guard may report historical private findings for owner-led remediation, but it must fail closed when the checkout or bounded blob scan is incomplete. Historical diagnostics must use categories and counts only; never emit matched values or raw private paths.

**Why:** A current-tree check cannot claim that an owner-approved history purge happened, while a shallow, partial, or budget-exhausted scan can create a false clean result.

**How to apply:** Keep completeness prerequisites ahead of historical content scanning, use a bounded batch object read, and separate remediation reporting from the current-tree merge gate until the release owner completes the purge.

Release approval evidence should be created only after all immutable revision and
approval-ref stability checks pass, using an exclusive create keyed to the
reviewed release and storing the resolved identities together.

**Why:** A later verification must not replace the approval identity captured by
an earlier release, and manual copying can combine values from different checks.

**How to apply:** Persist the approved ref, resolved approved commit, workspace
revision, and verification status in one append-once record; reject any later
write to that release record.