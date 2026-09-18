# UX E2E — Help Content

**Journey:** Help tab → introduction/content → offline cache → admin topics → retry  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/(tabs)/help.tsx` loads general Help from `/help`, optionally loads admin Help from `/help/admin`, caches only validated general content, and lets users dismiss/reopen the introduction. `utils/helpStorage.ts` owns the general cache and orientation key.

## Persistence and cross-context checks

General content can fall back to validated cached records and visibly says it is offline. Admin content is intentionally never read from local storage. `[MANUAL QA NEEDED]` verify cache revision changes, font scale, offline reload, and switching from admin to non-admin.

## Failure, retry, navigation, accessibility

General load failures have a Retry/empty error card. Admin-load failures are caught and the admin section is left empty without an error. Introduction dismissal updates immediately and persists asynchronously.

## Findings

### MEDIUM

#### F-091 · Help admin content · Phase 3 (Silent Failure)

**Failure:** A failed `/help/admin` request is intentionally reduced to `setAdminRecords([])` with no visible warning or retry. An admin cannot distinguish “there are no administrator topics” from “the protected Help request failed.”

**Fix:** `app/(tabs)/help.tsx` `loadContent` — keep general Help usable, but expose a separate admin-content error state with Retry and authorization-aware copy; never use cached privileged content.

### LOW

#### F-090 · Help introduction persistence · Phase 2 (State & Persistence)

**Failure:** `dismissOrientation` hides the introduction before the storage write completes. If the write fails, the current session says the introduction was dismissed but the next reload shows it again without explaining that the preference was not saved.

**Fix:** `app/(tabs)/help.tsx` dismissal handler and `helpStorage.ts` — await the save, retain an actionable persistence warning on failure, and keep the Intro action available.

## Seed/context

Help error-code and shared API contract work belongs to Task 1039 and existing Help infrastructure tasks. General cache validation and offline fallback are current behavior and are not re-reported.

## [MANUAL QA NEEDED]

- Offline first run versus cached reload.
- Admin/non-admin switch on one device.
- Large text, narrow layout, keyboard focus, and screen-reader topic expansion.

## Report-only stop

No fix or test change was made.
