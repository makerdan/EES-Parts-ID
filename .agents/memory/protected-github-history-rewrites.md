---
name: Protected GitHub history rewrites
description: Safe handling of one-time history rewrites when protected branches reject administrator force pushes.
---

For an approved protected-branch history rewrite, changing administrator
enforcement or force-push permission alone may still leave the update blocked.
GitHub can require both force pushes to be temporarily allowed and administrator
enforcement to be temporarily suspended.

**Why:** Force-push blocking remained absolute with administrator enforcement
off, while pull-request and required-check rules remained absolute with force
pushes allowed but administrator enforcement on.

**How to apply:** Build and fully verify the rewritten mirror first. Recheck
every remote ref against exact leases, update all changed refs atomically, and
wrap the temporary protection change in an exit trap that restores the complete
original contract. Re-read both remote refs and protection settings afterward.