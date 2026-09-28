---
name: Validation parity contract coverage
description: Repository validation contracts have multiple synchronized inventories for tier membership and remote coverage.
---

When adding a validation contract, update the executable tier registry and every repository-owned coverage inventory that asserts tier membership, including the GitHub Actions matrix and any companion registration maps.

**Why:** A contract can pass in isolation while the validation tier or parity report still omits it; the existing checks intentionally fail closed on those independent inventories.

**How to apply:** Search for `getTierSteps("standard-plus")` consumers and explicit contract maps before declaring a new validation step complete.

Platform-owned post-merge hooks need a separate evidence section from portable CI,
with live results labeled unavailable unless the hook actually ran. The parity
contract should source-check the configured hook's recognized responsibilities
against that section.

**Why:** The portable post-merge test exercises mocks and structural assertions,
not the Replit hook process; treating it as live coverage would overstate CI
parity and let newly added hook work disappear from the report.

**How to apply:** When `.replit` or `scripts/post-merge.sh` changes, keep the
hook-specific inventory and portable coverage wording synchronized.