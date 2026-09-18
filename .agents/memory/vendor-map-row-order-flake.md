---
name: reverseVendorMap tests depend on physical row order
description: vendorNameResolutionMap.integration.test.ts conflict-winner assertions rely on DB physical row order — now self-healing via repairConflictPageOrder() in beforeAll.
---

`vendorNameResolutionMap.integration.test.ts` asserts conflict winners (e.g. "eaton" → CHD, "eaton corporation" → ETN) based on which vendor row the DB returns *last* in an unordered SELECT. Physical row order changes whenever any suite updates or re-seeds vendor rows.

**Update July 2026:** `vendorNameResolutionMap.integration.test.ts` and its `repairConflictPageOrder()` beforeAll no longer exist in the repo — the self-heal is gone, and `vendorFilterResolution.integration.test.ts` (search endpoint, e.g. "EATON → CHD") also depends on the same winner ordering with NO self-repair. When it fails, repair the shared dev DB manually: delete the 7 conflict vendors and re-insert losers-first, winners-last (ABB → BUS → EAT → ETN → TAB → EDN → CHD); verify with `SELECT code, ctid FROM vendor_map WHERE code IN (...) ORDER BY ctid` (winners must have higher ctid). See `vendor-map-heap-order-tests.md`.

**Why this was previously a flake:** `onConflictDoUpdate` HOT-updates keep rows on their current page, so repeated seeding could leave winners and losers co-located, making scan order non-deterministic.
