# Keep Offline Search in the Selected Category

## What & Why
Exact offline Search cache identity currently omits the selected category, so users can see saved results from a different category when filters match. Make category identity part of exact-cache reads and writes.

## Done looks like
- Distinct category slugs produce distinct exact-search cache keys.
- A cached result from one category is never returned for another category or for an unfiltered search.
- Existing category-less cache entries are not read under the new identity format.
- Focused tests cover key identity, offline fallback, and category changes.

## Out of scope
- Search reset invalidation (covered by a separate task).
- Search preference hydration and broader cache-storage refactors.

## Steps
1. Extend exact-search cache identity to include the effective category and a new key version so old category-less entries cannot collide.
2. Pass the same category-aware identity through online cache writes and offline exact-cache lookups.
3. Add regression coverage for same-filter searches across two categories, category-to-general searches, and legacy keys.

## Pre-existing failures to ignore
- `public-repository-boundary` has failed because this checkout lacks provider-retained pull-request refs; the failure repeated in three isolated runs and is documented in `docs/bug-audit-parts-id-state-management.md`. Do not change unrelated remote or validation configuration.

**Flaky-test rule:** If another test fails, retry it three times in isolation before assigning ownership. A passing retry establishes intermittency, not pre-existing provenance.

## Validation
**Command:** `test-fast`
**Why:** This client/cache change needs the fast static and contract checks; focused Parts ID tests should also be run for direct regression evidence.
**Do not escalate:** Run exactly this completion command. The known history-boundary failure is unrelated and should be handled using the Failure Gate evidence rules.

## Regression Guard
Add a regression test proving identical filters cannot reuse exact offline results across category slugs or from an old category-less key.

## Relevant files
- `artifacts/parts-id/utils/searchHelpers.ts`
- `artifacts/parts-id/app/(tabs)/index.tsx`
- `artifacts/parts-id/__tests__/searchIndexHelpers.test.ts`
- `artifacts/parts-id/__tests__/searchFallback.test.ts`