---
name: vendor_map heap order dependence in vendor tests
description: Vendor resolution tests depend on physical DB row order; how they self-heal and what to do if they break.
---

The api-server `vendorNameResolutionMap.integration.test.ts` asserts last-write-wins conflict outcomes that depend on vendor_map seq-scan (heap) order. Declared winners: CHD after ETN/EAT, TAB after ABB, EDN after BUS (see DB_CONFLICT_WINNERS in that test file).

**Why:** `seedVendors()` uses `onConflictDoUpdate` (HOT update) which appends updated tuples within the same heap page, so repeated seeding can leave conflict rows co-located — breaking the last-row-wins semantic. Winners must be on strictly *later pages* (or at higher offsets on the same page) than their rivals.

**STALE NOTE (July 2026):** `repairConflictPageOrder()` no longer exists in the repo — the self-heal was removed/renamed away. When these tests fail, repair the DB manually: in one transaction, copy the 7 conflict rows (ABB, BUS, EAT, ETN, TAB, EDN, CHD) to a temp table, DELETE them from vendor_map, then re-insert losers first, winners last. `vendorFilterResolution.integration.test.ts` also depends on this order (EATON→CHD) and has NO self-heal.

Required insertion order: ABB → BUS → EAT → ETN → TAB → EDN → CHD.

**How to apply:** If these tests fail again after a seeding change:
1. Check that `repairConflictPageOrder()` still covers all conflict codes in `DB_CONFLICT_WINNERS`.
2. If new conflict pairs were added to `PRIMARY_VENDORS`, add the new loser/winner codes to `CONFLICT_CODES` in the correct relative position.
3. Verify with `SELECT code, ctid FROM vendor_map WHERE code IN (...) ORDER BY ctid` — winners must have higher ctid than their rivals.
