---
name: reverseVendorMap tests depend on physical row order
description: vendorNameResolutionMap.integration.test.ts conflict-winner assertions rely on DB physical row order and flake when vendor rows are updated/re-seeded.
---

`vendorNameResolutionMap.integration.test.ts` asserts conflict winners (e.g. "eaton electrical" → CHD) based on which vendor row the DB returns *last* in an unordered SELECT. Physical row order changes whenever any suite updates or re-seeds vendor rows, so these 3 tests fail intermittently (resolving EAT instead of CHD/ETN) with no code change.

**Why:** Postgres gives no ordering guarantee without ORDER BY; UPDATEs relocate tuples and change scan order.

**How to apply:** Treat these failures as a pre-existing flake unless the change touches vendor seeding/resolution. Real fix: make reverseVendorMap conflict resolution deterministic (explicit priority or ORDER BY) instead of last-row-wins.
