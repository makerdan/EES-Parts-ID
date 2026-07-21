---
name: vendor_map heap order dependence in vendor tests
description: Vendor resolution tests depend on physical DB row order; how to repair when they break.
---
The api-server vendor suites (vendorPriority, vendorNameResolutionMap, vendorFilterResolution) assert last-write-wins conflict outcomes that depend on vendor_map seq-scan (heap) order. Declared winners: CHD after ETN/EAT, TAB after ABB, EDN after BUS (see DB_CONFLICT_WINNERS in vendorNameResolutionMap.integration.test.ts).

**Why:** seedVendors() UPDATEs every row; HOT updates re-append tuples *within* a page in update order, so within-page ordering is unreliable — winners must be on strictly *later pages* than their rivals. Same-page placement (e.g. ETN and CHD both in page N) makes seed array order win instead.

**How to apply:** if these suites fail with Expected CHD / Received ETN etc., rebuild vendor_map: set fillfactor=50, TRUNCATE, re-insert rivals first, then ~60 throwaway padding rows (force page break), then ETN/TAB/EDN, more padding, then CHD last; delete padding. Verify with `SELECT code, ctid FROM vendor_map WHERE code IN (...) ORDER BY ctid` — winners must have higher page numbers. Also: shared-DB jest runs must never overlap (test/test:coverage are wrapped with scripts/serial-lock.mjs) or cross-run fixture deletion corrupts these suites.
