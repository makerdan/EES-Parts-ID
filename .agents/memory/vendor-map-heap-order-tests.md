---
name: vendor_map heap order dependence in vendor tests
description: Vendor resolution tests depend on physical DB row order; how they self-heal and what to do if they break.
---

The api-server `vendorNameResolutionMap.integration.test.ts` asserts last-write-wins conflict outcomes that depend on vendor_map seq-scan (heap) order. Declared winners: CHD after ETN/EAT, TAB after ABB, EDN after BUS (see DB_CONFLICT_WINNERS in that test file).

**Why:** `seedVendors()` uses `onConflictDoUpdate` (HOT update) which appends updated tuples within the same heap page, so repeated seeding can leave conflict rows co-located — breaking the last-row-wins semantic. Winners must be on strictly *later pages* (or at higher offsets on the same page) than their rivals.

**Self-healing fix (now in the test):** `repairConflictPageOrder()` runs in `beforeAll` after `seedVendors()`. It deletes the 7 conflict vendors (ABB, BUS, EAT, ETN, TAB, EDN, CHD) and re-inserts them in the correct order — losers first, winners last — so page/offset ordering is always correct at test time. No manual DB surgery needed.

Required insertion order: ABB → BUS → EAT → ETN → TAB → EDN → CHD.

**How to apply:** If these tests fail again after a seeding change:
1. Check that `repairConflictPageOrder()` still covers all conflict codes in `DB_CONFLICT_WINNERS`.
2. If new conflict pairs were added to `PRIMARY_VENDORS`, add the new loser/winner codes to `CONFLICT_CODES` in the correct relative position.
3. Verify with `SELECT code, ctid FROM vendor_map WHERE code IN (...) ORDER BY ctid` — winners must have higher ctid than their rivals.
