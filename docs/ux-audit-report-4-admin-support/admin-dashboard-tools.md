# UX E2E — Admin Dashboard Tools

**Journey:** People & System → Admin Dashboard → load/refresh/export/map tools → return  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/admin.tsx` fetches `/admin/dashboard-stats`, renders privacy-bounded summary/AI/screen-view data, exports CSV, and links to calibration and mockup map tools. The root stack registers `/admin` and `/admin-map-calibration`.

## Persistence and cross-context checks

Dashboard metrics are server-backed and reloaded on mount; export is generated from the currently rendered snapshot. No dashboard snapshot is persisted locally. `[MANUAL QA NEEDED]` verify web download and native share behavior, return navigation, narrow layouts, font scale, and expired-admin behavior.

## Failure, retry, navigation, accessibility

Initial load has a spinner and Retry. Refresh uses pull-to-refresh but a rejected refresh sets the same `error` state used for initial load. External links are opened directly with `Linking.openURL`.

## Findings

### HIGH

#### F-079 · Admin dashboard refresh · Phase 3 (Silent Failure)

**Failure:** A refresh rejection sets `error` while leaving `stats` in memory, but rendering checks `error` before `stats` and replaces the loaded dashboard with an error-only screen. An admin loses the evidence they were reviewing and has no stale-data indicator while retrying.

**Fix:** `app/admin.tsx` `fetchStats` and render branch — preserve loaded stats during refresh errors, show an inline stale/error banner with Retry, and reserve the full empty error state for an initial load with no snapshot.

### MEDIUM

#### F-080 · Admin dashboard map tools · Phase 5 (Navigation)

**Failure:** Zone Editor and Warehouse Map actions call `Linking.openURL` without a rejection handler. An unsupported scheme, blocked popup, or unavailable mockup route leaves the admin on the dashboard with no explanation or copyable fallback.

**Fix:** `app/admin.tsx` map-tool `Pressable`s — await `Linking.openURL`, catch failures, and show an actionable alert/toast with a copyable URL or Retry.

#### F-081 · Admin dashboard export · Phase 3 (Error & Edge Case)

**Failure:** On native, `Sharing.isAvailableAsync()` can return false and the handler simply completes after writing a cache file. The admin sees no export confirmation, location, or fallback; web has no success announcement either.

**Fix:** `app/admin.tsx` `handleExport` — distinguish generated, shared, unavailable, and failed outcomes; show a success message and a copy/share fallback when native sharing is unavailable.

### LOW

#### F-082 · Admin dashboard controls · Phase 12 (Accessibility)

**Failure:** Back, export, and refresh controls rely on icons with no explicit accessibility labels. The export and refresh disabled states are also not announced.

**Fix:** `app/admin.tsx` header controls — add labels, roles, and disabled/busy state; expose the reporting window and export outcome to assistive technology.

## [MANUAL QA NEEDED]

- Web download permission/popup behavior and native share-sheet availability.
- Returning from calibration/map tools with an expired session.
- Responsive tables/chart at narrow width and large font scale.
- Screen-reader announcement of refreshed/stale metrics.

## Report-only stop

No fix or test change was made.
