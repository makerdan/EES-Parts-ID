# UX E2E — Admin Hub Section Recovery

**Journey:** Admin tab → select Import, AI & Enrichment, Warehouse, or People & System → leave/reload → return  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/(tabs)/upload.tsx` owns the admin hub, `activeSection`, the `admin_activeSection` AsyncStorage key, and all four section bodies. A clean admin can select a card, use the section back control, switch tabs, and return. Non-admin rendering is gated by `AdminRestricted`; linked routes are reached from People & System.

## Persistence and cross-context checks

- The selected section is persisted across tab switches, but the write path is fire-and-forget.
- Section-local state is not persisted; returning restores the section shell, not an in-progress upload/query/job.
- `[MANUAL QA NEEDED]` Reload the web preview and a native device after each section selection; verify the selected section and active job state agree.
- `[MANUAL QA NEEDED]` Sign out, sign in as a different approved user, and verify no previous section-specific content or query text is exposed.

## Failure, navigation, accessibility

The section back control returns to the hub. The API pill is interactive for health check and long-press restart. Cards use `Pressable`, but labels/state are inherited from visible text rather than explicit semantic metadata.

## Findings

### MEDIUM

#### F-077 · Admin hub section recovery · Phase 2 (State & Persistence)

**Failure:** `AsyncStorage.setItem` and `removeItem` failures for `admin_activeSection` are caught with empty callbacks. The hub can show a selected section while its next reload silently returns to the default hub, and the admin receives no indication that recovery was not saved.

**Fix:** `app/(tabs)/upload.tsx` active-section persistence effect — await writes through a guarded helper, expose a small “Could not save your place — retry” state, and keep the selected section available until the retry succeeds. Add a focused storage-rejection workflow assertion.

### LOW

#### F-078 · Admin hub section recovery · Phase 12 (Accessibility)

**Failure:** Section cards and the section back control do not provide explicit accessibility labels or selected/expanded state. A screen-reader user can enter a card but cannot reliably identify the current section or the action that returns to the hub.

**Fix:** `app/(tabs)/upload.tsx` hub card and header `Pressable`s — add `accessibilityRole`, stable labels, and `accessibilityState={{ selected: ... }}` where applicable; label the back action as “Back to Admin Hub.”

## Seed/context

The prior reports’ admin data-entry findings F-005, F-012, F-014, and F-015 concern bulk-session persistence and remain separate. This report does not duplicate them. People action consistency belongs to the People journey report.

## [MANUAL QA NEEDED]

- Browser reload and native background/foreground after each section selection.
- Narrow web width, large font scale, keyboard focus after returning to the hub.
- Second-user sign-in on the same device.

## Report-only stop

No fix or test change was made.
