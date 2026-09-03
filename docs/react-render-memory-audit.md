# React Render & Memory Audit

**Mode:** Report-only  
**Scope:** `artifacts/parts-id` and `artifacts/mockup-sandbox`  
**Audit date:** 2026-08-28  
**Source scope:** React/React Native source files only; tests and generated `static-build` output were excluded.

## Phase 0 — Stack inventory

| Flag | Detected value | Evidence | Gates |
|---|---|---|---|
| React present | Yes in both artifacts | React and React DOM dependencies in both manifests; React imports throughout source | React phases |
| React Native present | Yes in Parts ID; no in Canvas | `artifacts/parts-id/package.json:68`; no React Native dependency/import in `artifacts/mockup-sandbox` | RN checks in Phases 2, 3, and 5 |
| React version | 19.1.0 | Workspace catalog in `pnpm-lock.yaml` resolves `react` and `react-dom` to `19.1.0` | React 18+ checks |
| Animation library present | Yes | Parts ID uses React Native `Animated` and Reanimated; Canvas declares Framer Motion, but no Framer Motion usage was found in source | Animated checks |
| Worklet-capable animation present | Yes in Parts ID; no confirmed usage in Canvas | `react-native-reanimated` and `react-native-worklets` in Parts ID; Reanimated/worklet APIs are absent from Canvas source | Worklet checks |
| Global error boundary | Yes for Parts ID; no confirmed boundary for Canvas | `artifacts/parts-id/components/ErrorBoundary.tsx` is mounted by `app/_layout.tsx`; no `ErrorBoundary`, `componentDidCatch`, or `getDerivedStateFromError` in Canvas source | Resilience context |
| Test suite | Yes in both artifacts | Jest test script/files in Parts ID; Vitest test script/files in Canvas | Automated regression guard available, but Phase 8 is gated off |

## Summary

| Severity | Count |
|---|---:|
| Critical | 2 |
| High | 24 |
| Medium | 4 |
| Low | 0 |
| **Total** | **30** |

## Findings

### Critical

ID: R-001  
Component: `artifacts/parts-id/app/(tabs)/index.tsx:1731-1748` — `IndexScreen` results `FlatList`  
Phase: Phase 3 — Reference Stability Audit, React Native virtualized-list gate  
Severity: Critical  
Failure: Every parent render creates a new `ListHeaderComponent` type, so the virtualized list can remount the entire header subtree. During search/result updates this can discard header-local state and repeatedly restart its effects.  
Fix: Extract the header into a stable component, or pass a memoized renderer with the required values.  
Evidence: `<FlatList` at line 1731 and `ListHeaderComponent={() => (` at line 1747.

ID: R-002  
Component: `artifacts/parts-id/components/BrowseByCategory.tsx:545-552` — `SubcategoryList`  
Phase: Phase 3 — Reference Stability Audit, React Native virtualized-list gate  
Severity: Critical  
Failure: Every render recreates the `FlatList` header component, causing the “All category” header subtree to remount during normal list updates.  
Fix: Extract the header to a stable component or provide a memoized renderer with stable dependencies.  
Evidence: `<FlatList` at line 545 and `ListHeaderComponent={() => (` at line 551.

### High

ID: R-003  
Component: `artifacts/parts-id/contexts/AppContext.tsx:748-776` — `AppProvider`  
Phase: Phase 3 — Reference Stability Audit, Context provider gate  
Severity: High  
Failure: A new context value object is created on every provider render, invalidating every `AppContext` consumer even when the exposed values have not changed.  
Fix: Wrap the provider value in `useMemo`, including every exposed state value and callback in its dependency list, or split the context by update frequency.  
Evidence: `<AppContext.Provider value={{` at line 749 and the inline object through line 776.

ID: R-004  
Component: `artifacts/parts-id/contexts/ApiHealthContext.tsx:24-34` and `artifacts/parts-id/hooks/useApiStatus.ts:224` — `ApiHealthProvider`  
Phase: Phase 3 — Reference Stability Audit, Context provider gate  
Severity: High  
Failure: `useApiStatus` returns a new result object on each render and the provider passes it directly to context, causing all health-banner consumers to rerender whenever the provider renders.  
Fix: Memoize the returned result object in `useApiStatus`, or memoize the provider value over the result fields.  
Evidence: `const result = useApiStatus({` at `ApiHealthContext.tsx:26`, `<ApiHealthContext.Provider value={result}>` at line 31, and the object return at `useApiStatus.ts:224`.

ID: R-005  
Component: `artifacts/parts-id/app/(tabs)/measure.tsx:113-131` — `MeasureScreen` focus lifecycle  
Phase: Phase 4 — Stale Closure Audit  
Severity: High  
Failure: The focus cleanup captures the `phase` from the render that registered the callback. If the screen enters `"scanning"` without a permission dependency change, blur or unmount sees the old phase and does not call `cancelMeasure()`.  
Fix: Read the current phase through a ref in cleanup, or include `phase` while ensuring focus resets do not create unwanted churn.  
Evidence: Cleanup tests `if (phase === "scanning")` at lines 125-127, but the callback dependencies are only `[permission, requestPermission]` at line 130.

ID: R-006  
Component: `artifacts/parts-id/contexts/AppContext.tsx:569-578` — `AppProvider` settings bootstrap effect  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: `loadSettings()` can resolve after the provider unmounts and still call `setSettings` and `setSettingsLoaded`, leaving async work alive across navigation.  
Fix: Add an effect-local cancellation guard or abortable storage operation and check it before both state updates.  
Evidence: `loadSettings().then((s) => {` at line 571 followed by `setSettings(s)` and `setSettingsLoaded(true)` at lines 572-574; the effect has no cleanup.

ID: R-007  
Component: `artifacts/parts-id/app/(tabs)/upload.tsx:1048-1090` — `UploadScreen` admin job-status bootstrap effect  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: The initial enrichment-status requests can resolve after navigation/unmount, update upload state, or start polling for a screen that no longer exists.  
Fix: Use an effect-local `AbortController` or cancellation guard, pass its signal to both requests, and guard all setters and polling starts.  
Evidence: The effect invokes `fetchEnrichSummary()` and an async IIFE at lines 1057-1058; it calls `setBulkJobStatus`, `setMeasureJobStatus`, and `setUploadError` at lines 1074, 1081, and 1087. Cleanup at lines 1093-1097 only stops polling and a debounce timer.

ID: R-008  
Component: `artifacts/parts-id/app/(tabs)/index.tsx:600-650` — `IndexScreen` offline cache/history bootstrap effects  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: AsyncStorage continuations can resolve after the screen unmounts, update Fuse/history state, and trigger a full inventory sync after the screen has gone away.  
Fix: Add cancellation guards to both effects and check them before `buildFuseIndex`, `setFuseSyncedAt`, history setters, and every `syncAllInventory()` call.  
Evidence: The cache effect chains `AsyncStorage.getItem(FUSE_CACHE_KEY)` at lines 604-644 and updates `setFuseSyncedAt` at line 629; the history effect calls `.then(setQueryHistory)` and `.then(setViewedHistory)` at lines 647-650. Neither effect returns cleanup.

ID: R-009  
Component: `artifacts/parts-id/app/admin.tsx:224-249` — `AdminScreen.fetchStats` bootstrap  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Dashboard loading can finish after the admin screen unmounts and execute its success, error, and `finally` setters on an inactive screen.  
Fix: Pass an abort signal or use a mounted/request-generation guard around `setStats`, `setError`, `setRefreshing`, and `setLoading`.  
Evidence: `fetchStats()` is invoked by the effect at lines 245-249; the awaited request is at lines 230-235 and the unguarded setters are at lines 235-241. The effect has no cleanup.

ID: R-010  
Component: `artifacts/parts-id/components/ReferenceModal.tsx:125-136` — `ReferenceModal` lookup prefetch  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: A modal-open prefetch can reject after the modal unmounts and call `setPrefetchFailed`, producing an update against an abandoned modal instance.  
Fix: Add a mounted/cancelled guard around the prefetch continuation, or make the prefetch operation abortable and cancel it on modal cleanup.  
Evidence: `prefetchQuickLookups` awaits `prefetchQuickLookupsImpl` at lines 125-128 and catches with `setPrefetchFailed(true)` at line 129; `handleModalShow` starts that async path at lines 133-136 with no cancellation path.

ID: R-011  
Component: `artifacts/parts-id/components/CatalogPdfUpload.tsx:489-508` — `CatalogPdfUpload` resume-restore effect  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: The mount-time AsyncStorage continuation can run after unmount, restore job state, and start a new polling loop after the component cleanup has already run.  
Fix: Add a cancellation guard to the effect and check it before `setJobStatus` and `startPolling`; cancel or ignore the restore continuation on cleanup.  
Evidence: `AsyncStorage.getItem(ACTIVE_JOB_KEY).then(...)` at line 495 calls `setJobStatus` at lines 497-505 and `startPolling(storedJobId)` at line 506; the effect has no cleanup.

ID: R-012  
Component: `artifacts/parts-id/hooks/useApiStatus.ts:43-70` — `useApiStatus` health poll  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Blur/unmount stops the interval but does not abort the currently running health request. Its resolution or rejection can still call `setStatus` and `setBots` after the hook is gone.  
Fix: Track the active poll controller in a ref, abort it from polling/unmount cleanup, and guard state updates against unmount/request cancellation.  
Evidence: `poll` creates a local controller at lines 45-46 and unconditionally calls `setStatus`/`setBots` at lines 51-69. The cleanup at lines 120-128 only clears timers and does not abort that controller.

ID: R-013  
Component: `artifacts/parts-id/hooks/useApiStatus.ts:130-154` — `useApiStatus.probeSingleBot`  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: A bot probe can continue after unmount or admin-token change and call `setBots` on an inactive hook; its controller is only timeout-aborted.  
Fix: Store active probe controllers, abort them during unmount/dependency cleanup, and guard the post-JSON `setBots` update with mounted/current-request checks.  
Evidence: A local controller is created at lines 132-133, while `setBots(parsed.data.bots)` at line 149 is unguarded. The hook cleanup at lines 120-128 does not abort probe controllers.

ID: R-014  
Component: `artifacts/parts-id/hooks/useApiStatus.ts:156-217` — `useApiStatus.triggerRestart`  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Unmount can occur while the restart request is pending. The continuation then schedules resume-poll timers, and the restart request itself is not aborted by cleanup.  
Fix: Keep the restart controller and a mounted/request-generation guard in refs; abort on unmount and do not schedule resume polling after cancellation.  
Evidence: `restartController` is local at lines 162-163, while cleanup only clears existing timer IDs at lines 120-127. The continuation unconditionally schedules a new timer at lines 176-215.

ID: R-015  
Component: `artifacts/parts-id/contexts/AppContext.tsx:638-659` — `AppProvider` admin refresh interval/AppState callbacks  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Interval/AppState cleanup removes future callbacks but cannot cancel an in-flight `refreshAdminStatus` request. The request calls `verifyAdmin` without a signal and can update auth state after provider unmount.  
Fix: Use a shared refresh controller or request-generation guard, pass its signal through `refreshAdminStatus` to `verifyAdmin`, and abort it from both effect cleanups.  
Evidence: Both callbacks invoke `refreshAdminStatus()` at lines 650 and 656; it calls `verifyAdmin(token)` without a signal at line 645. `verifyAdminRequest` updates admin state without a signal at `utils/verifyAdminRequest.ts:54-66`, while the effects only clear the interval/remove the subscription at lines 651 and 658.

ID: R-016  
Component: `artifacts/mockup-sandbox/src/pages/ZoneEditor.tsx:767-786` — `ZoneEditor` floor-plan loading effect  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: The floor-plan fetch can resolve after `ZoneEditor` unmounts and still update SVG state.  
Fix: Add an `AbortController` or cancellation guard, pass its signal to fallback requests, abort during cleanup, and ignore cancellation errors.  
Evidence: `await fetch(url)` at line 774 is followed by `setSvgInner` and `setSvgDims` at lines 777-778; the effect has no cleanup.

ID: R-017  
Component: `artifacts/mockup-sandbox/src/pages/ZoneEditor.tsx:883-914` — `ZoneEditor.fetchZones` and coverage refresh  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: The primary zone request and nested coverage request can resolve after unmount and update zones, drag state, coverage, errors, or loading state. The generation counter handles superseded requests but not unmount.  
Fix: Abort both requests and guard every state update with mounted/cancelled state; pass the signal into the nested coverage fetch too.  
Evidence: The primary fetch and state updates are at lines 889-910; the nested coverage fetch updates `setCoverage` at lines 899-903. The mount effect at line 914 has no cancellation cleanup.

ID: R-018  
Component: `artifacts/mockup-sandbox/src/pages/ZoneEditor.tsx:1738-1775` — `ZoneEditor` debounced auto-save effect  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Cleanup cancels only an unfired timer. Once the callback starts, save/refetch completion can update state, refs, undo history, drafts, and toasts after unmount.  
Fix: Add cancellation/abort handling and check it after each await before `setSaveStatus`, `pushUndo`, ref mutations, draft writes, toast calls, or `fetchZones`.  
Evidence: The callback awaits `patchZone` at line 1760 and then calls `setSaveStatus`, `toast.success`, and `fetchZones` at lines 1764-1766; cleanup at line 1774 only calls `clearTimeout`.

ID: R-019  
Component: `artifacts/mockup-sandbox/src/pages/ZoneEditor.tsx:2015-2153` — document `mouseup` handler `onUp`  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Removing the document listener on unmount does not stop an already-running async mouseup operation. Move, resize, and multi-move paths can continue PATCHes/refetches and state updates after the editor is gone.  
Fix: Add mounted/cancelled checks after every await, abort requests in effect cleanup, and reset interaction refs during cleanup.  
Evidence: `const onUp = async` at line 2015; move/resize awaits and updates are at lines 2077-2099, and multi-move awaits/refetch updates are at lines 2115-2140. Cleanup at lines 2149-2153 only removes listeners.

ID: R-020  
Component: `artifacts/mockup-sandbox/src/pages/AnchorCalibration.tsx:140-223` — `AnchorCalibration` initial floor-plan, anchor, and zone/alignment loads  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Any of the initial floor-plan, anchor, or zones/alignment requests can resolve after unmount and update SVG, anchor, error, loading, zones, or alignment state. The same unguarded anchor refetch is also reused by save/clear actions.  
Fix: Thread an `AbortSignal` through the initial fetches and `refetchAnchors`, abort on unmount, and guard every post-await setter while ignoring cancellation errors.  
Evidence: Floor-plan fetch/setter paths are at lines 140-160; `refetchAnchors` fetches and setters at lines 168-194 and is invoked by the effect at lines 196-198; zones/alignment fetches and setters are at lines 200-223. None of these loading effects returns cancellation cleanup.

ID: R-021  
Component: `artifacts/mockup-sandbox/src/pages/AnchorCalibration.tsx:359-464` — `AnchorCalibration.handleSave` and `handleClear`  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Save or clear requests can complete after unmount and update slot status, global status, anchors, or create success-reset timers for an abandoned editor.  
Fix: Use an unmount cancellation ref/controller and guard every post-await setter and timer creation.  
Evidence: `handleSave` awaits PUT and `refetchAnchors` at lines 379-405, then sets status/timer at lines 406-410; `handleClear` follows the same pattern at lines 435-454.

ID: R-022  
Component: `artifacts/mockup-sandbox/src/pages/ZoneEditor.tsx:1866-1942` — `ZoneEditor.handleFillClick`  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Main-thread rasterization and the 300 ms feedback delay can outlive the component, after which multiple state setters and toast work still run on the abandoned editor.  
Fix: Add cancellation checks after rasterization and the delay, make the work abortable where possible, and skip all setters/toasts when cancelled.  
Evidence: Awaits occur at lines 1895 and 1923, followed by `setFillFlashRect`, `setPendingRect`, `setSelectedIds`, `setForm`, `setMode`, and `setFillLoading` through lines 1924-1940.

ID: R-023  
Component: `artifacts/mockup-sandbox/src/pages/WarehouseMapViewer.tsx:74-89` — `WarehouseMapViewer` floor-plan loading effect  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: The latest floor-plan request can resolve after the read-only viewer unmounts and call `setSvgInner`.  
Fix: Add an effect-local `AbortController` or cancelled guard to the local/fallback fetch loop and clean it up on unmount.  
Evidence: `await fetch(url)` at line 81 is followed by `setSvgInner(...)` at line 83; the effect ends at line 89 without cleanup.

ID: R-024  
Component: `artifacts/mockup-sandbox/src/pages/WarehouseMapViewer.tsx:98-110` — `WarehouseMapViewer` zone loading effect  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: The zone request can resolve after navigation and call `setZones` or `setZonesError` on an unmounted viewer.  
Fix: Pass an abort signal or use a cancelled guard, and skip both success and error setters after cleanup.  
Evidence: `await fetch(`${API_BASE}/warehouse-zones`)` at line 102 is followed by `setZones` at line 105 and `setZonesError` at line 107; the effect has no cleanup.

ID: R-025  
Component: `artifacts/mockup-sandbox/src/components/ui/carousel.tsx:121-145` — `CarouselContext.Provider`  
Phase: Phase 3 — Reference Stability Audit, Context provider gate  
Severity: High  
Failure: Every `Carousel` render creates a new context value object, invalidating all carousel consumers even when its constituent values are unchanged.  
Fix: Memoize the provider value over `carouselRef`, `api`, `opts`, `orientation`, navigation callbacks, and scroll booleans.  
Evidence: Inline `value={{ ... }}` at lines 122-133; `CarouselContent`, `CarouselItem`, `CarouselPrevious`, and `CarouselNext` consume the context at lines 155, 177, 199, and 228.

ID: R-026  
Component: `artifacts/mockup-sandbox/src/components/ui/form.tsx:34-36, 80-82`; `toggle-group.tsx:27`; `chart.tsx:47` — context providers  
Phase: Phase 3 — Reference Stability Audit, Context provider gate  
Severity: High  
Failure: These providers recreate object values on every provider render and invalidate their consumers even when the logical values have not changed.  
Fix: Memoize `{ name: props.name }`, `{ id }`, `{ variant, size }`, and `{ config }`, or split primitive context fields.  
Evidence: Inline provider values are present at the cited lines; `useContext` consumers exist in the form, toggle-group, and chart implementations.

### Medium

ID: R-027  
Component: `artifacts/parts-id/components/BrowseByAisle.tsx:192-200` — `AisleRow` highlight animation  
Phase: Phase 2 — React Native Animated lifecycle gate  
Severity: Medium  
Failure: A 1.2-second timing animation started by an effect is not stopped when the row unmounts or the highlight dependency changes, allowing work to continue against an abandoned animated value.  
Fix: Retain the timing animation in a ref and call `.stop()` in effect cleanup before restarting or disposing it.  
Evidence: `Animated.timing(glowOpacity, ...).start()` at lines 195-199; the effect has no cleanup return.

ID: R-028  
Component: `artifacts/parts-id/components/BulkShelfAssign.tsx:424-443` — `BulkShelfAssign` completion effect  
Phase: Phase 2 — React Native Animated lifecycle gate  
Severity: Medium  
Failure: The completion animation is launched from an effect without unmount cleanup, so navigating away during the transition leaves the animation running.  
Fix: Store the `Animated.parallel` handle and call `.stop()` from effect cleanup.  
Evidence: `Animated.parallel([...]).start()` at lines 435-438; the effect has no return cleanup before its dependency list at line 443.

ID: R-029  
Component: `artifacts/mockup-sandbox/src/hooks/use-toast.ts:9, 56-72` — `useToast` module toast store  
Phase: Phase 5 — Memory Accumulation Audit  
Severity: Medium  
Failure: Dismissed toasts remain retained in the module-level `toastTimeouts` map until the one-million-millisecond timeout fires. Repeated dismiss cycles therefore retain timer/map entries for roughly 16.7 minutes.  
Fix: Use a bounded removal delay and clear/delete timeout entries on immediate removal through a shared cleanup helper.  
Evidence: `TOAST_REMOVE_DELAY = 1000000` at line 9; module-level `toastTimeouts` at line 56; deletion occurs only inside the delayed callback at lines 63-71.

ID: R-030  
Component: `artifacts/mockup-sandbox/src/hooks/use-toast.ts:169-180` — `useToast` subscription effect  
Phase: Phase 3 — Reference Stability Audit  
Severity: Medium  
Failure: The listener is removed and recreated after every toast state update because `state` is in the effect dependency array, causing avoidable listener-array churn under active toast traffic.  
Fix: Change the dependency array from `[state]` to `[]`; `setState` is stable and cleanup already removes that exact listener.  
Evidence: Listener registration/cleanup is at lines 172-179 and the dependency array is `}, [state])` at line 180.

## Explicit no-finding checks

- **Phase 1 — Effect cleanup:** No additional missing cleanup was confirmed for browser wheel/keyboard listeners, `useRubberBand` document drag listeners, match-media listeners, polling intervals, success timers, or `AppState` subscriptions. The missing lifecycle guards are reported above where the resource is async work or an Animated operation.
- **Phase 1 — Sockets/observers:** No WebSocket, `ResizeObserver`, `IntersectionObserver`, `MutationObserver`, or uncleaned event-emitter subscription was confirmed.
- **Phase 2 — React Native animation:** Parts ID `MeasureScreen`, `MeasurePartScreen`, `PartCard`, and the Reanimated map paths stop/cancel their animations; R-027 and R-028 are the confirmed missing cleanups.
- **Phase 3 — Dependency-array literals:** No confirmed object/array/arrow literal in a hook dependency array was found in the application source.
- **Phase 3 — Context:** The unstable provider values are R-003, R-004, R-025, and R-026.
- **Phase 3 — React Native lists:** The confirmed inline virtualized-list header remounts are R-001 and R-002. No additional confirmed `renderItem`, footer, or separator remount finding was found.
- **Phase 4 — Stale closures:** R-005 is the only confirmed stale mutable-state closure. Other reviewed interval callbacks use functional updates or refs; no `useTransition` or `startTransition` path was found.
- **Phase 5 — Module caches:** Parts ID map/floor-plan caches and Canvas raster caches are bounded or one-entry. No component instance, DOM node, native view, or closure retention was confirmed. R-029 is the only confirmed unbounded-duration toast timer/map retention issue.
- **Phase 5 — React Native `require()`:** No repeated resource-allocating `require()` was found in a Parts ID render/effect path; static asset imports were not treated as findings.
- **Phase 6 — Render correctness:** No conditional hook calls, render-time async work/subscriptions, or render-time external mutations were confirmed. Large Canvas derived calculations are memoized where inspected, and no confirmed unstable props defeating a `React.memo` child were found.
- **Phase 6 — Animation worklets:** Parts ID Reanimated worklet callbacks did not show a confirmed avoidable re-serialization defect. Canvas declares Framer Motion but no Framer Motion animation usage was found.

## Audit disposition

This was a report-only run. No Parts ID or Canvas application source was changed, and the Phase 8 fix/regression-hardening loop was not run. The findings above require separate approval before fixes are applied.