# UX E2E Audit — Run 2: Search · Map · Photo/Measure · Barcode · Auth · Edit-Item · Ref Modal
**Mode:** Report-only
**Scope:** J5 Search · J6 Map · J7 Photo/Measure · J8 Barcode scan/add · J9 Auth flows · J10 Edit-Item · J11 Reference Modal
**Phases covered:** 0–12
**Phase gates:** Phase 6 skipped (no keyboard shortcuts in these flows). Phase 7 skipped (no multi-tool switching). Phase 9 applied (auth: true).
**Prior audit:** F-001–F-023 documented in `docs/ux-audit-report.md`; several already fixed (F-001–F-004, F-008, F-011, F-016, F-022) or in-progress (F-005–F-007, F-009–F-010, F-012–F-015, F-017–F-023).

## Stack flags
- backend: true · auth: true · multi-tool: false · interactions: false

## App Map (this run)
- J5 Search: keyword search, filters, browse by aisle/category, results, re-enrich, map pin, recent history, settings
- J6 Map: floor-plan load, zone browse, cycle count, aisle summary, zone editor (admin)
- J7 Photo/Measure: take/pick part photo, LiDAR scan, AI photo estimate, confirm dimensions
- J8 Barcode: scan barcode, look up part, assign shelf, add new part via scan, edit barcode
- J9 Auth: sign-up, email verify, login, OAuth (Google/Apple), SSO callback, pending approval, banned
- J10 Edit-Item: edit part details, keywords, bin, dimensions, photo
- J11 Reference Modal: ask AI, chip lookups, prefetch, contact support

---

## Summary
| Severity | Count |
|---|---|
| Critical | 2 |
| High | 20 |
| Medium | 17 |
| Low | 6 |
| **Total** | **45** |

---

## Findings

### ⚠ CRITICAL

---

F-024 · J8 Barcode lookup · Phase 3 (Silent Failure)
Journey: Scan barcode → look up part
Failure: If `resolveBarcode` throws an unexpected error, the rejection is uncaught at the call
site. The UI stays frozen on "Looking up…" indefinitely with no timeout, error message, or
retry action. The user cannot recover without restarting the app.
Fix: `BarcodeScreen.tsx:181-219` — wrap the `resolveBarcode` call in try/catch; on failure set
an error state and show a "Lookup failed — tap to retry" banner.

---

F-025 · J6 Map (web) · Phase 3 (Silent Failure)
Journey: Open Map tab on web → view floor plan
Failure: `map2.tsx` dynamic-imports the warehouse map module on web. If the import rejects
(bundle missing, network error, parse failure), the error is completely swallowed. The component
stays on an infinite `ActivityIndicator` with no error text, retry button, or fallback. The user
cannot tell whether the map is loading or broken.
Fix: `app/(tabs)/map2.tsx:59-78` — catch the dynamic import in a try/catch; on failure render
an error card with a Retry button that re-attempts the import.

---

### HIGH

---

F-026 · J9 Auth (login) · Phase 3 (Silent Failure)
Journey: Enter email + password → sign in
Failure: `signIn.create()` and `signIn.attemptFirstFactor()` are called inside a try block, but
a thrown network error or SDK exception propagates as an unhandled rejection, crashing the
handler and leaving the form in a broken state with no error shown.
Fix: `app/login.tsx:37-54` — add a catch block that sets a visible error state for
network/unexpected errors, separate from the existing field-error handler.

---

F-027 · J9 Auth (sign-up verify) · Phase 3 (Silent Failure)
Journey: Enter email verification code → complete sign-up
Failure: `signUp.attemptEmailAddressVerification()` errors are not caught. If the code is wrong
or expired, the call throws and the user stays on the verification screen with no feedback.
The `signUp.status` read after the call may also be stale, preventing completion even on success.
Fix: `app/sign-up.tsx:53-70` — wrap the verification call in try/catch; surface
`err.errors[0]?.message` as a visible field error; re-read fresh status from the returned object.

---

F-028 · J9 Auth (sign-up code send) · Phase 1 (Happy Path)
Journey: Enter email → request verification code → receive code
Failure: `signUp.prepareEmailAddressVerification()` on the send and resend paths has no error
handling. A network failure or Clerk API error is swallowed; the user stays on the form with no
explanation, no retry state, and no rate-limit feedback.
Fix: `app/sign-up.tsx:42-50,237-243` — catch send/resend errors and set an error message; add
a retry button that re-fires the prepare call.

---

F-029 · J9 Auth (SSO) · Phase 3 (Silent Failure)
Journey: Tap Google/Apple → complete OAuth → land in app
Failure: The SSO callback catch block redirects all errors (provider failure, config error,
network, expired token, user cancellation) to the login screen with no message. Admins and
users cannot distinguish a config problem from a cancelled flow.
Fix: `app/sso-callback.tsx:33-57` — map error codes to user-readable messages ("Sign-in was
cancelled", "Provider error — try again", "Session expired"); display them before or on redirect.

---

F-030 · J9 Auth (OAuth web) · Phase 1 (Happy Path)
Journey: Tap Google sign-in on web
Failure: The web OAuth path calls `useClerk().client.signIn.authenticateWithRedirect`, which
does not exist on `@clerk/react` 6.11.3's `useSignIn()`. The corrected path via
`useClerk().client.signIn` is guarded — but if the guard condition misses, the call silently
does nothing with no error shown.
Fix: `components/OAuthButtons.tsx:88-90` — assert the web path resolves to a callable and add
a fallback error toast if `authenticateWithRedirect` is unavailable.

---

F-031 · J9 Auth (pending approval) · Phase 3 (Silent Failure)
Journey: Sign up → wait for admin approval → check status
Failure: The manual-check call on the pending screen (`GET /admin/me` or Clerk status) has no
error handling. A network failure looks identical to "still pending": the spinner clears, the
page re-renders with no change, and the user has no indication the check failed.
Fix: `app/pending.tsx:22-36` — catch polling/check errors; show a visible "Check failed —
tap to retry" message rather than silently returning to the waiting state.

---

F-032 · J9 Auth (pending/banned logout) · Phase 4 (Error & Edge Case)
Journey: Pending or banned user taps Sign Out
Failure: The logout call on the pending and banned screens has no error handling. A failure
disables the Sign Out button (spinner state) but never re-enables it and shows no error, leaving
the user permanently stuck on the screen with an unresponsive button.
Fix: `app/pending.tsx:29-32,135-145`; `app/banned.tsx:18-21,99-109` — add a finally block
that re-enables the logout button; show a toast on failure.

---

F-033 · J9 Auth (gate flash) · Phase 1 (Happy Path)
Journey: Any authenticated route loaded directly
Failure: `AuthGate` performs auth checks and redirects in a `useEffect`, but renders no loading
state in the interim. The protected screen's content briefly renders before the redirect fires,
exposing UI (tabs, data) to unauthenticated or unapproved users for one render cycle.
Fix: `components/AuthGate.tsx:24-66` — render a blank/loading screen while `isLoaded` is false
or while admin status is being resolved; only render `{children}` once identity is confirmed.

---

F-034 · J8 Barcode (assignment) · Phase 4 (Double-submit)
Journey: Scan barcode → tap Assign to Shelf
Failure: Assignment action handlers in `BarcodeScreen` have no in-flight guard. Rapid taps or
a slow server response allow concurrent mutations — the part can be double-assigned or the UI
can show conflicting states simultaneously.
Fix: `BarcodeScreen.tsx:258-279` — add an `assigning` ref/state; disable the action button
and return early while a mutation is in flight.

---

F-035 · J8 Barcode (camera denied) · Phase 4 (Error & Edge Case)
Journey: Deny camera permission → try to scan a barcode in BarcodeEditor
Failure: `BarcodeEditor` requests camera permission but on permanent denial renders no "Open
Settings" action. The user sees a blank scanner or a disabled editor with no path to resolution.
Fix: `components/BarcodeEditor.tsx:52-59` — detect `status === 'denied'`; show an "Open
Settings" button that calls `Linking.openSettings()`.

---

F-036 · J8 Barcode (shelf session race) · Phase 2 (State & Persistence)
Journey: Scan parts → add to shelf → navigate away and back
Failure: `BarcodeAddPart` fires shelf-session saves and clears without awaiting them. If a save
and a subsequent clear overlap, the clear can win, then the stale save resolves and restores
an old session that the user already completed.
Fix: `components/BarcodeAddPart.tsx:278-282,559-584` — await session writes; or serialise
writes through a queue; surface storage failures with a toast.

---

F-037 · J6 Map (aisle summary) · Phase 1 (Happy Path)
Journey: Long-press a zone → view aisle summary
Failure: `AisleSummarySheet` returns `null` when inventory is empty, unavailable, or fails to
parse. The long-press gesture appears to do nothing — no bottom sheet, no error, no explanation.
Users assume the gesture is broken.
Fix: `components/AisleSummarySheet.tsx:25-34,74-82` — render a bottom sheet with an "No
inventory in this aisle" empty state instead of returning null.

---

F-038 · J7 Photo (pick/capture) · Phase 3 (Silent Failure)
Journey: Tap camera or library picker to add a part photo
Failure: `PartPhotoPicker`'s camera and library picker calls are not wrapped in try/catch.
A runtime exception from the picker (permission revoked mid-session, OS-level crash, unsupported
media) becomes an unhandled promise rejection with no user-visible feedback.
Fix: `components/PartPhotoPicker.tsx:28-70` — wrap both picker calls in try/catch; show a toast
on failure; disable the buttons during the picker session to prevent concurrent launches.

---

F-039 · J5 Search (timeout) · Phase 3 (Silent Failure)
Journey: Submit a search query → wait → see results
Failure: After the 8-second timeout fires, the mutation is reset and the UI falls back to
potentially stale Fuse data with no message. The user sees results but does not know the live
search failed or that the data may be outdated.
Fix: `app/(tabs)/index.tsx:813-883` — after timeout, set a visible banner ("Search timed out
— showing cached results") with a Retry button; do not silently present stale data.

---

F-040 · J10 Edit-Item (unsaved changes) · Phase 2 (State & Persistence)
Journey: Edit part fields → tap Cancel or Back
Failure: Cancel, the back gesture, modal close, and the "Show on Map" action all dismiss
the edit screen without checking for unsaved changes, including while active saves are in
flight. In-progress edits are silently discarded.
Fix: `app/edit-item.tsx:1363-1387` — track a `hasUnsavedChanges` flag; show a
"Discard changes?" confirmation dialog before dismissing when the flag is set.

---

F-041 · J6 Map (cycle count) · Phase 3 (Silent Failure)
Journey: Long-press zones to mark cycle count → reload map
Failure: `AsyncStorage.setItem` for cycle-count writes is not awaited and has no catch.
If the write fails, the zone is marked in the UI but the state is not persisted. After reload,
the counted zone reappears as uncounted with no warning.
Fix: `app/(tabs)/map.tsx:343-355` — await the storage write; on failure show a toast ("Could
not save count — tap zone again to retry") and revert the local toggle.

---

F-042 · J6 Map (zone editor) · Phase 3 (Silent Failure)
Journey: Tap Zone Editor button (admin)
Failure: `Linking.openURL(zoneEditorUrl)` is not wrapped in a catch. If the URL cannot open
(unsupported scheme, OS restriction), the promise rejects silently with no fallback message.
Fix: `app/(tabs)/map.tsx:438-469` — catch the `Linking.openURL` call; show a toast with the
URL if opening fails so the admin can copy it manually.

---

F-043 · J6 Map (floor plan error) · Phase 3 (Silent Failure)
Journey: Open Map tab → floor plan fails to load
Failure: Server failure, bundle fetch failure, and parse errors all collapse to the same
generic "Map unavailable" state with no retry button, no error detail, and no indication of
whether the problem is transient or permanent.
Fix: `components/WarehouseMapView.tsx:236-323` — distinguish server vs. bundle vs. asset
failure; show a Retry button on transient errors; log the error code in the message
("Map unavailable — server error 503, tap to retry").

---

F-044 · J6 Map (tile fetch) · Phase 3 (Silent Failure)
Journey: Pinch-zoom into a high-zoom floor plan area
Failure: Individual PNG tile fetch failures are fully swallowed. High-zoom areas silently
render blank or stay at low resolution with no indicator that tiles failed to load and no
retry path.
Fix: `components/WarehouseMapView.tsx:650-697` — on tile fetch failure, retry once after 2s;
if still failing, render a subtle "Tap to reload map" banner.

---

F-045 · J6 Map / Admin · Phase 5 (Navigation)
Journey: Admin navigates directly to `/admin-map-calibration` via deep link
Failure: The `admin-map-calibration` route is not declared in the root `Stack` navigator. A
direct deep-link visit may fail to match the route and redirect to the tabs instead, making
the admin calibration screen unreachable from external links or push notifications.
Fix: `app/_layout.tsx:109-121` — add `<Stack.Screen name="admin-map-calibration" />` to the
root Stack; confirm AuthGate enforces admin role for this route.

---

### MEDIUM

---

F-046 · J9 Auth (OAuth concurrency) · Phase 4 (Double-submit)
Journey: Tap Google, then Apple before Google resolves
Failure: Google and Apple OAuth have independent loading flags, so both can be launched
concurrently. Stalled OAuth flows have no timeout, so a hung provider leaves the buttons
disabled indefinitely.
Fix: `components/OAuthButtons.tsx:78-80,121-151` — use a single `oauthLoading` flag shared
across providers; add a 60s timeout that re-enables buttons and shows an error.

---

F-047 · J9 Auth (SSO spinner) · Phase 4 (Error & Edge Case)
Journey: OAuth redirect → land on /sso-callback
Failure: The SSO callback renders an indefinite spinner. There is no timeout, no cancel
action, and no handling for a user arriving at the URL directly (no `code` param). The user
is permanently stuck unless they force-reload.
Fix: `app/sso-callback.tsx:33-71` — add a 30s timeout that shows "Sign-in taking too long —
go back and try again"; handle missing/invalid params with an immediate error state.

---

F-048 · J9 Auth (gate indefinite wait) · Phase 2 (State & Persistence)
Journey: Open app while Clerk session is loading
Failure: `AuthGate` waits indefinitely while `isLoaded === false` or approval status is `idle`/
`loading`. A Clerk SDK hang or network outage leaves the user staring at a blank screen
with no timeout, no retry, and no error.
Fix: `components/AuthGate.tsx:45-46,64` — add a 15s timeout; if exceeded, show an error
screen with a "Try again" button that reloads the Clerk session.

---

F-049 · J9 Auth (pending poll timing) · Phase 2 (State & Persistence)
Journey: Approved by admin → app detects approval
Failure: The first automatic approval poll fires after 30 seconds. Concurrent slow requests
can overlap. An admin who approves a user immediately may wait up to 30s for the app to
reflect it, with no "checking…" indicator.
Fix: `app/pending.tsx:13-27` — fire one check immediately on mount; show a "Checking…"
indicator during the check; prevent poll overlap with an in-flight guard.

---

F-050 · J8 Barcode (session load silent fail) · Phase 2 (State & Persistence)
Journey: Resume a barcode add-part session
Failure: Session data load and persistence failures in `BarcodeAddPart` are silently
discarded. Malformed or missing storage data is treated as no session with no warning,
so a user returning to an interrupted flow gets no explanation of why their previous
state is gone.
Fix: `components/BarcodeAddPart.tsx:130-150,265-282` — on storage parse failure, toast
"Previous session could not be restored"; on persistence failure, toast "Could not save
progress — session may not resume".

---

F-051 · J8 Barcode (recent scan silent fail) · Phase 3 (Silent Failure)
Journey: Scan a barcode → expect recent-scan lookup
Failure: Recent-scan lookup failures in `BarcodeScreen` are silently ignored. The user
sees no results and no explanation of whether the barcode is unknown or the lookup failed.
Fix: `components/BarcodeScreen.tsx:232-245` — on lookup failure, show a "Lookup failed —
tap to retry" inline state; distinguish "not found" from "error".

---

F-052 · J8 Barcode (scan error auto-dismiss) · Phase 10 (UI Feedback)
Journey: Barcode scan returns an error
Failure: Generic scan errors in `BarcodeScanModal` auto-dismiss after 2 seconds. If the
error is actionable (wrong barcode type, permission issue), the user may not read it in
time and the scanner resets silently.
Fix: `components/BarcodeScanModal.tsx:240-243,259-277` — keep actionable errors visible until
the user taps Dismiss; only auto-dismiss "no barcode detected"-type informational messages.

---

F-053 · J8 Barcode (editor close without confirm) · Phase 2 (State & Persistence)
Journey: Edit a barcode → tap close/cancel
Failure: `BarcodeEditor` closes without confirmation when unsaved barcode input is present.
Edits are silently discarded with no warning.
Fix: `components/BarcodeEditor.tsx:170-172,256-265` — track a `isDirty` flag; show
"Discard changes?" before closing if dirty.

---

F-054 · J6 Map (bundled SVG res.ok) · Phase 3 (Silent Failure)
Journey: Open Map tab → floor plan loads from bundle fallback
Failure: The native bundled SVG fetch at `WarehouseMapView.tsx:305-323` does not check
`res.ok`. A non-200 response is parsed as SVG content, caching an empty/error body as
the floor plan. The next load shows a blank map with no indication of the original failure.
Fix: `components/WarehouseMapView.tsx:305-323` — add `if (!res.ok) throw new Error(res.status)`;
then fall through to the generic error state.

---

F-055 · J7 Measure (AI estimate timeout) · Phase 4 (Error & Edge Case)
Journey: Take photo → request AI dimension estimate
Failure: The photo-estimate fetch to the AI endpoint has no client-side timeout or
cancellation. On a slow connection, the user waits indefinitely on the estimate screen
with no indication of progress or a way to cancel.
Fix: `components/MeasurePartScreen.tsx:352-419` — add an `AbortController` with a 30s
timeout; on abort, show "Estimate timed out — tap to retry or enter dimensions manually".

---

F-056 · J7 Measure (permission silent fail) · Phase 3 (Silent Failure)
Journey: Open Measure tab → camera permission requested
Failure: `requestPermission()` is called in a `useEffect` visibility handler without being
awaited and without a catch. A permission-request failure is completely silent — the user
sees neither a denial message nor an "Open Settings" prompt.
Fix: `components/MeasurePartScreen.tsx:246` — await `requestPermission()` in an async
effect; catch errors; if status is `denied`, show the Settings prompt.

---

F-057 · J11 Reference Modal (prefetch silent fail) · Phase 3 (Silent Failure)
Journey: Open Reference Modal → quick-lookup chips appear
Failure: `prefetchQuickLookups` is awaited in the `onShow` handler but its failure is not
caught at the call site. If prefetch fails, chips silently fail to pre-populate. Tapping
a chip then makes a visible request — but the user may have assumed chips were instant.
Fix: `components/ReferenceModal.tsx:124-130` — wrap the `prefetchQuickLookups` await in
try/catch; on failure, set a flag to show chips as "tap to load" rather than appearing ready.

---

F-058 · J10 Edit-Item / J8 Barcode (photo partial fail) · Phase 11 (Data Lifecycle)
Journey: Add part → upload photos → one slot fails
Failure: `ShelfCatalogEntry` uses `Promise.allSettled` and shows a partial-upload warning,
but there is no retry path for the failed photo slots. The user must re-open the item and
re-upload manually, with no direct link or action offered.
Fix: `components/ShelfCatalogEntry.tsx:226-244,305-313` — after partial failure, surface
a "Retry failed photos" button that re-attempts only the failed slots.

---

F-059 · J5 Search (re-enrich fail) · Phase 10 (UI Feedback)
Journey: Tap Re-enrich Keywords on a result card
Failure: A re-enrich failure updates a local `⚠ Failed` label on the card. There is no
error detail, no retry button distinct from tapping the same card action, and the failed
state disappears when the card unmounts.
Fix: `components/ResultCard.tsx:134-145,450-465` — on failure, show a toast with a
"Retry" action; persist the failed state (or log it) so it is not silently lost.

---

F-060 · J5 Search (variant dropdown dismissal) · Phase 5 (Navigation)
Journey: Open "Other Sizes" variant dropdown → tap away to close
Failure: `SizeVariantDropdown` has no outside-tap or Escape dismissal. The only way to
close it is to tap the trigger button again or select a row. The dropdown can obstruct
results below it with no escape.
Fix: `components/SizeVariantDropdown.tsx:45-57` — wrap in a `Modal` with a transparent
backdrop Pressable, or add a `useEffect` that closes the dropdown on outside tap via a
root-level touch handler.

---

F-061 · J6 Map (cycle count on web) · Phase 12 (Cross-context)
Journey: Use cycle-count feature on web
Failure: The cycle-count zone toggle uses `onLongPress`, which is native-only. On web,
the same action has no equivalent — the cycle-count button is shown but zone toggling
silently fails, and the counted state cannot be set via any other gesture.
Fix: `components/WarehouseMapView.tsx:464-473,535-544` — add a web-compatible fallback
(e.g., `onContextMenu` or a click-activated mode toggle) for cycle-count marking.

---

F-062 · J6 Map (select mode discovery) · Phase 10 (UI Feedback)
Journey: Tap a zone to open Zone Action Menu
Failure: Zone taps are ignored unless the user has explicitly entered select mode via a
separate button. The default UI does not explain this; new users tap zones expecting
the action menu and nothing happens. No tooltip, hint, or affordance explains select mode.
Fix: `components/WarehouseMapView.tsx:2238-2266,2551-2567` — show a one-time coach mark
or hint text ("Tap the select icon to interact with zones") on first visit; or allow a
single tap in default mode to prompt entering select mode.

---

### LOW

---

F-063 · J8 Barcode (dev-only option in prod) · Phase 12 (Cross-context)
Journey: Open barcode scanner
Failure: "Skip camera (dev only)" buttons in `BarcodeScreen` and `BarcodeAddPart` are not
guarded by `__DEV__`. They are visible in production builds, exposing a bypass path and
cluttering the scanner UI for real users.
Fix: `BarcodeScreen.tsx:293-313`; `BarcodeAddPart.tsx:597-615` — wrap both buttons in
`{__DEV__ && ...}`.

---

F-064 · J6 Map (empty state auto-hide) · Phase 10 (UI Feedback)
Journey: Admin opens map with no zones defined
Failure: The "No zones defined" informational card auto-hides after 3 seconds and is
non-interactive. An admin who glances away misses it and sees a blank map with no
indication of why it is empty.
Fix: `app/(tabs)/map.tsx` — make the card persistent until the user dismisses it; add an
admin-only "Set up zones" link to the Zone Editor.

---

F-065 · J5 Search (empty variant dropdown) · Phase 10 (UI Feedback)
Journey: View a search result with no size variants
Failure: `SizeVariantDropdown` renders an enabled "Other Sizes ▾ (0)" trigger even when
there are no variants. Tapping it opens an empty scroll panel, which is confusing.
Fix: `components/SizeVariantDropdown.tsx:45-61` — hide the trigger entirely when
`variants.length === 0`, or render it as non-interactive with a tooltip.

---

F-066 · J7 Photo (lightbox navigation) · Phase 10 (UI Feedback)
Journey: Open photo lightbox to browse part images
Failure: `PhotoLightbox` uses arrow buttons only — no swipe gesture, no pinch-to-zoom.
Image load failures show a blank area with no error message or retry.
Fix: `components/PhotoLightbox.tsx` — add swipe gesture navigation; add an error state
in the image slot that shows "Photo unavailable" on load failure.

---

F-067 · J5 Search (accessibility) · Phase 12 (Cross-context)
Journey: Navigate search screen with assistive technology
Failure: Search, Apply, filter chips, sync retry, Settings, Reference, and most result
action buttons lack `accessibilityLabel` and `accessibilityRole`. Screen readers cannot
identify these controls.
Fix: `app/(tabs)/index.tsx:1139-1196,1565-1584,1988-2025`; `components/FilterPanel.tsx:190-227`
— add `accessibilityLabel` and `accessibilityRole` to all interactive controls.

---

F-068 · J5 Search (passive error display) · Phase 10 (UI Feedback)
Journey: Search fails / goes offline / sync fails
Failure: Search errors, sync failures, and offline-fallback events are communicated only via
banners and cards that are easy to miss, especially when results are already displayed.
No toast is fired. The sync error banner auto-dismisses via user tap only, so failure can
persist silently while stale inventory is shown.
Fix: `app/(tabs)/index.tsx:1511-1529,1709-1749` — fire a brief toast on first occurrence
of each error class; keep the banner for persistent state; add a prominent stale-age label
when results are older than 24h.

---

## Seed findings status (F-001–F-023)
| ID | Status |
|---|---|
| F-001, F-002 | Fixed (Task #858 merged) |
| F-003 | Fixed (Task #859 merged) |
| F-004 | Fixed (Task #860 merged) |
| F-005 | Fix in progress (Task #861) |
| F-006, F-007 | Fix in progress (Task #862) |
| F-008, F-016 | Fixed (Task #863 merged) |
| F-009 | Pending (Task #864) |
| F-010 | Fix in progress (Task #865) |
| F-011, F-022 | Fixed (Task #866 merged) |
| F-012, F-014, F-015 | Fix in progress (Task #867) |
| F-013 | Pending (Task #868) |
| F-017 | Pending (Task #869) |
| F-018 | Pending (Task #870) |
| F-019–F-021, F-023 | Pending (Task #871) |
