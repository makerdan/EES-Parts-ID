---
name: Unmount react-test-renderer trees before flushing timers
description: How "Cannot log after tests are done" leaks arise in parts-id suites and the fix pattern
---

Rule: any suite that mounts a component with react-test-renderer must unmount
every tree in afterEach (wrapped in `act`) — and must do so BEFORE calling
`jest.runOnlyPendingTimers()`.

**Why:** Components like WarehouseMapView and SearchScreen schedule timers
(3s empty-state auto-dismiss, 30s sync-retry backoff) whose callbacks call
setState. Under `--runInBand` a timer left alive after a suite fires during a
later suite and emits "Cannot log after tests are done" — the classic vector
for order-dependent flakes. `runOnlyPendingTimers()` while still mounted is
just as bad: it fires the retry timer, whose async chain setStates after the
suite ends. Component cleanup already clears the timers — only on unmount.

**How to apply:** track mounted renderers in an array (`trackTree` helper
pushed inside the mount helper), then in afterEach pop-and-unmount each inside
`await act(async () => t.unmount())`, then flush/restore timers. See
fitButtonSnap, searchResultMemoStability, searchOfflineInstant,
searchSlowLinkTimeout tests for the pattern.
