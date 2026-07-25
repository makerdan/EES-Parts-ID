---
name: reverseVendorMap tests depend on physical row order
description: vendorNameResolutionMap.integration.test.ts conflict-winner assertions rely on DB physical row order — now self-healing via repairConflictPageOrder() in beforeAll.
---

`vendorNameResolutionMap.integration.test.ts` asserts conflict winners (e.g. "eaton" → CHD, "eaton corporation" → ETN) based on which vendor row the DB returns *last* in an unordered SELECT. Physical row order changes whenever any suite updates or re-seeds vendor rows.

**Fix (now in test):** `repairConflictPageOrder()` runs in `beforeAll` after `seedVendors()` — deletes the 7 conflict vendors and re-inserts them in loser-before-winner order, guaranteeing correct page/offset ordering on every run. See `vendor-map-heap-order-tests.md` for full details.

**Why this was previously a flake:** `onConflictDoUpdate` HOT-updates keep rows on their current page, so repeated seeding could leave winners and losers co-located, making scan order non-deterministic.
