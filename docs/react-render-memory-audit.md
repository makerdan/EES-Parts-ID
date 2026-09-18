# React Render & Memory Audit

**Mode:** Report-only  
**Scope:** Parts ID React Native application, Canvas React application, and the React-facing API contract boundary  
**Audit date:** 2026-09-03  
**Canonical skill:** `.agents/skills/react-render-audit/SKILL.md`

## Audit scope and exclusions

The application scope is all non-test JavaScript/TypeScript source under
`artifacts/parts-id` and `artifacts/mockup-sandbox`, including components,
custom hooks, providers, null-rendering components, entry points, and utility
hooks used by those trees. The inspected source inventory contains 162 Parts ID
files and 77 Canvas files after excluding tests, mocks, `static-build`, and
Canvas `.generated` output.

The contract-boundary scope is the OpenAPI source at `lib/api-spec/openapi.yaml`,
the public barrels at `lib/api-client-react/src/index.ts` and
`lib/api-zod/src/index.ts`, the generated operation/type exports those barrels
expose, and the non-test application imports and call shapes that consume them.
Generated client/schema implementation internals, API-server internals,
dependencies, fixtures, UX journeys, and broad correctness/security review are
out of scope. Contract observations that do not affect React rendering,
lifecycle, or memory safety are recorded separately and are not counted as
render-audit findings.

## Phase 0 — Discovery & stack inventory

| Flag | Detected value | Evidence | Gates |
|---|---|---|---|
| React present | Yes in Parts ID and Canvas | Both artifact manifests use the workspace React catalog; React imports and `createRoot`/React components are present throughout both source trees | React phases |
| React Native present | Yes in Parts ID; no in Canvas | `artifacts/parts-id/package.json:67-77` declares `react-native: 0.81.5`, and the source imports React Native APIs; Canvas has no React Native dependency or import | React Native checks in Phases 2, 3, and 5 |
| React version | 19.1.0 | `pnpm-workspace.yaml:25-26` pins `react` and `react-dom` to `19.1.0`; `pnpm-lock.yaml:45-50,665-670` resolves that version | React 18+ concurrent-rendering checks in Phase 4 |
| Animation library present | Yes in Parts ID; no JavaScript animation library in Canvas | Parts ID uses React Native `Animated` and declares `react-native-reanimated` and `react-native-worklets` in `artifacts/parts-id/package.json:70-77`; Canvas has no Framer Motion dependency or animation API import (CSS animation classes are not JS animation handles) | Animated lifecycle checks in Phase 2 |
| Worklet-capable animation present | Yes in Parts ID; not applicable in Canvas | Parts ID imports Reanimated worklet APIs in `components/WarehouseMapView.tsx:47-58` and defines worklets at `:108-112,393-418`; Canvas has no Reanimated/worklet API | Phase 6 worklet check |
| Global error boundary | Yes for Parts ID; no confirmed boundary for Canvas | `components/ErrorBoundary.tsx:16-34` is mounted around the Parts ID provider tree by `app/_layout.tsx:101-129`; Canvas `src/main.tsx:1-5` mounts `App` directly and no `ErrorBoundary`, `componentDidCatch`, or `getDerivedStateFromError` exists in Canvas source | Resilience context |
| Test suite | Yes in both artifacts; contract drift tests also exist | Parts ID has Jest scripts and test files, Canvas has Vitest scripts and test files, and `lib/api-spec/src/__tests__/check-route-drift.test.ts` covers contract drift | Phase 8 automated-test guard is available but Phase 8 is disabled in report-only mode |

React 18+ checks are therefore applicable. React Native, React Native
`Animated`, Reanimated/worklet, virtualized-list, and Context checks are
applicable where the inventory above says so. Canvas React Native and worklet
checks are explicitly not applicable.

## Phase 1 — Effect cleanup audit

All 60 effect-bearing application source files found by the concrete
`useEffect`/`useLayoutEffect` search were inspected, including custom hooks,
providers, null-rendering paths, and effects that only synchronize refs.
`useLayoutEffect` was not found in either application.

In Parts ID, AppState, keyboard, logout, storage-error, focus, listener,
polling-interval, debounce, success-timer, and Animated cleanup paths were
inspected. The catalog-review polling effect clears its intervals on cleanup,
but an already-running request is not cancelled; that is reported as the
async lifecycle finding R-002. The upload AI-status bootstrap starts requests
without an effect-owned cancellation path; that is reported as R-003.

In Canvas, wheel, focus, visibility, keyboard, carousel/Embla, sidebar,
match-media, and rubber-band document listeners have matching cleanup. Zone
editor, anchor calibration, and warehouse viewer fetches use abort controllers
and cleanup. Calibration success timers and Zone Editor debounce/fill/drag
resources are cancelled. The toast store does remove its React listener, but
its dependency array recreates that listener after each state update (R-005);
the delayed toast timer/map retention is R-004.

**Phase 1 result:** No uncleaned socket, observer, browser listener, or event
emitter was confirmed. Missing cancellation of already-running async work is
covered in Phase 2 rather than duplicated here.

## Phase 2 — Async lifecycle audit

Every application fetch/async continuation found in the Parts ID and Canvas
source trees was inspected for an abort controller, mounted/current-request
guard, dependency-change cancellation, rejection handling, and post-await
state updates.

Three current findings were confirmed:

- `catalog-review.tsx` bootstrap requests are not abortable or mounted-guarded
  (R-001).
- Its interval callback clears the future interval but does not cancel or
  guard a poll request already in flight (R-002).
- Upload's admin AI-status fetch and manual probe update state without a
  mounted/request-generation guard (R-003).

The following current guards were specifically re-inspected and no longer
support the corresponding prior findings: AppContext settings bootstrap,
admin profile sync, admin role refresh, and settings sync; IndexScreen cache
and history bootstrap; AdminScreen stats; ReferenceModal prefetch;
CatalogPdfUpload restore/polling; `useApiStatus` health, bot-probe, restart,
and recovery flows; ZoneEditor floor-plan/zones/coverage loading, autosave,
document mouseup, and fill; AnchorCalibration loading/save/clear; and
WarehouseMapViewer floor-plan/zones loading.

### React Native Animated lifecycle gate

This gate is applicable because Parts ID uses React Native `Animated`. Every
effect-driven `Animated.start()` path inspected in Measure, MeasurePartScreen,
PartCard, BrowseByAisle, BulkShelfAssign, and map overlays either stops the
matching animation or cancels it through the relevant cleanup path. The former
BrowseByAisle and BulkShelfAssign findings are resolved; no current Animated
lifecycle finding was confirmed.

## Phase 3 — Reference stability audit

Dependency arrays, `useCallback`, `useMemo`, forwarded handlers, virtualized
list props, and Context providers were inspected across both application
trees.

The former inline virtualized-list headers in Parts ID now use the memoized
`searchListHeader` node at `app/(tabs)/index.tsx:1237-1249` and the stable
`React.memo` `BrowseListHeader` at `components/BrowseByCategory.tsx:525-563`,
passed as an element at `:591-601`. No SectionList usage or additional
confirmed inline renderer remount was found.

`AppContext` now memoizes its complete provider value at
`contexts/AppContext.tsx:825-873`, `ApiHealthContext` memoizes its exposed
value at `contexts/ApiHealthContext.tsx:40-58`, and the Canvas carousel, form,
toggle-group, and chart providers memoize their values. No confirmed object,
array, or arrow literal in a hook dependency array was found in application
source.

The Canvas toast subscription is the one surviving reference-stability issue:
the effect registers and removes the same listener but depends on `state`,
causing avoidable listener-array churn for every toast update (R-005).

## Phase 4 — Stale closure audit

All `useCallback`, `useImperativeHandle`, forwarded handlers, interval
callbacks, auth/client references, and dependency arrays were inspected.
Parts ID auth token access uses `getTokenRef`, and request generation/mounted
refs are used in the guarded flows listed in Phase 2. Interval callbacks use
functional state updates or refs where state must remain current. Canvas
interaction handlers use refs for mutable interaction state and update
callbacks in effects where needed.

The former Measure focus-cleanup stale `phase` closure is resolved: the
current focus lifecycle reads current state through its ref-aware cleanup path
at `app/(tabs)/measure.tsx:113-131`. No other stale mutable-state callback was
confirmed.

React 18+ checks were applicable because React 19.1.0 is installed. No
`useTransition` or `startTransition` path was found in either application, so
there is no concurrent-rendering assumption to report. No callback was found
that assumes a render or event runs exactly once.

## Phase 5 — Memory accumulation audit

The module-level mutable collections, caches, service-like singletons, and
React Native `require()` paths were inspected.

Parts ID's chip cache is a bounded LRU with a 500-entry limit
(`utils/chipCache.ts:15-19,38-55`). The floor-plan cache is one-entry/in-flight
state (`utils/floorPlanCache.ts:50-55`), and stale tile-pyramid directories are
cleaned (`utils/tilePyramidCache.ts:93-117`). Warehouse map SVG loading shares
one in-flight promise and abort controller, with retry self-healing for
unusable settled data (`components/WarehouseMapView.tsx:120-176`). No cache
entry was found to retain a component instance, DOM node, native view, or
long-lived closure.

Canvas's Zone Editor raster cache and fill-worker cache are each single-entry
caches. Interaction Maps/Sets are component-scoped and bounded by the current
zone selection. The Canvas toast store has a module-level `toastTimeouts` map;
its delayed removal retention is the current finding R-004.

The React Native runtime `require()` search found only the static font asset
require in `app/_layout.tsx:79`, gated during component initialization. No
repeated resource-allocating `require()` was found in a render or effect path.
No unbounded service singleton, socket, observer, or module collection was
confirmed beyond the bounded-duration toast timer/map retention in R-004.

## Phase 6 — Render correctness audit

Large sort/filter/reduce/parse computations, memoized-child props, hook
ordering, render-time side effects, and animation callbacks were inspected.
Large derived Parts ID lists and Canvas zone/raster-derived values are
memoized or bounded by the data flow. No confirmed conditional hook call,
render-time async work, subscription, external mutation, or unstable prop that
defeats a confirmed `React.memo` child was found.

### Animation worklet gate

This gate is applicable to Parts ID. Reanimated callbacks in
`WarehouseMapView` use explicit worklet-safe bodies and shared values; no
confirmed avoidable worklet re-serialization or frame-impacting callback
recreation was found. The `use no memo` directive on the large
`ZoneOverlayItem` is an intentional React Compiler compatibility guard, not a
finding.

The gate is not applicable to Canvas: its manifest and source have no
worklet-capable animation library or JS animation API. CSS/Tailwind
`animate-*` classes were not treated as JavaScript lifecycle resources.

## API-client/schema contract boundary result

The API boundary was inspected separately from server internals. The public
client barrel at `lib/api-client-react/src/index.ts:1-3` exports the custom
fetch, generated operations, and generated schemas. The Zod barrel at
`lib/api-zod/src/index.ts:1-5` exports generated validators and the
hand-maintained profile, help, inventory, and analytics validators.

The generated operation paths and application call shapes reviewed for list,
search, update, photo, barcode, keyword, AI-identification, and warehouse
operations agree with the OpenAPI/client contract. The app passes an
origin-only base URL to the generated client, so no `/api/api` double-prefix
was found. No missing client-barrel export, wrong generated mutation shape,
or client/schema-induced render, lifecycle, or memory defect was confirmed.

The following contract observations are real but outside the render/memory
finding count:

1. `AiIdentifyBody.images` has OpenAPI `maxItems: 2` at
   `lib/api-spec/openapi.yaml:1372-1394`, while the Photo screen permits up to
   four images at `artifacts/parts-id/app/(tabs)/photo.tsx:147-180` and sends
   all selected images at `:252-255,352-355`. The generated type documents the
   maximum but cannot enforce it at compile time, and the hand-maintained
   `AiIdentifyBodySchema` allows up to 10. This is payload-validation drift,
   not a React render/lifecycle/memory defect.
2. OpenAPI/generated `InventoryItem` makes `orderPurchase` and `orderQuantity`
   optional (`lib/api-spec/openapi.yaml:857-862` and generated types
   `:99-106`), while the hand-maintained inventory Zod schema requires them at
   `lib/api-zod/src/inventoryRoutes.ts:3-9`. Current UI consumers defensively
   handle absent values; no render/lifecycle/memory consequence was evidenced.
3. Several app endpoints are raw fetch contracts not represented in the
   OpenAPI/generated boundary, including catalog-PDF, map-anchor, admin-role,
   and several inventory routes. They are outside this generated-boundary
   audit and are not treated as client export or render findings.

## Phase 7 — Triage & report

Findings are re-issued consecutively in current severity order. Prior IDs are
mapped in the reconciliation table below; resolved findings are not repeated
as current findings.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 3 |
| Medium | 2 |
| Low | 0 |
| **Total** | **5** |

### High

ID: R-001  
Component: `artifacts/parts-id/app/catalog-review.tsx:219-323` — `CatalogReviewScreen.fetchItems` bootstrap  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: The initial review/failed-job or job-status requests can resolve after the catalog review screen unmounts or the admin token changes, then update groups, job summary, errors, loading state, or resume polling for an abandoned screen.  
Fix: Give `fetchItems` an effect/request-owned `AbortController` or current-request guard, pass its signal to both requests, and check liveness before every post-await setter, logout action, and polling start.  
Evidence: `fetchItems` constructs raw requests at `:219-238`, parses and updates state at `:240-311`, and updates error/loading state at `:313-319`; the effect invokes it at `:323`. Its dependency list at `:320-321` contains no cancellation state, and the fetches have no `signal`.

ID: R-002  
Component: `artifacts/parts-id/app/catalog-review.tsx:330-407` — `CatalogReviewScreen` resume status poll  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Clearing the resume interval on navigation prevents future ticks but does not stop a status request already in flight. Its continuation can update progress, mark a job stalled, invalidate caches, call `fetchItems`, or start more work after the screen is gone.  
Fix: Track each active poll controller or use a poll-generation/mounted guard, abort it from the screen/token cleanup, and check the guard before all progress, error, cache-invalidation, and follow-up calls.  
Evidence: The interval callback begins at `:330-338` and performs an unguarded request; continuations update state and invoke follow-up work at `:339-386` and `:388-405`. Cleanup at `:430-437` clears interval IDs only and cannot cancel the already-running request.

ID: R-003  
Component: `artifacts/parts-id/app/(tabs)/upload.tsx:664-705` — `UploadScreen.fetchAiStatus` and `triggerAiProbe`  
Phase: Phase 2 — Async Lifecycle Audit  
Severity: High  
Failure: Admin AI-status loading and manual probing can finish after navigation, unmount, or admin-token replacement and then update loading, error, probe, or bot state on an abandoned upload screen.  
Fix: Share an effect/request-generation guard or active controllers between these operations, pass signals to both fetches, abort/invalidate them on cleanup/token change, and guard success, error, and finally setters.  
Evidence: `fetchAiStatus` performs an unabortable request and setters at `:664-680`; `triggerAiProbe` does the same at `:682-699`; the bootstrap effect invokes `fetchAiStatus` at `:701-705` without a cancellation cleanup. The separate `useApiStatus.probeSingleBot` path is guarded and is not part of this finding.

### Medium

ID: R-004  
Component: `artifacts/mockup-sandbox/src/hooks/use-toast.ts:9,54-70` — module toast store  
Phase: Phase 5 — Memory Accumulation Audit  
Severity: Medium  
Failure: Each dismissed toast retains its ID and timer in the module-level map until the one-million-millisecond delay expires. Repeated dismiss cycles therefore retain timer/map entries and scheduled callbacks for roughly 16.7 minutes, even though the toast is no longer visible.  
Fix: Use a materially shorter removal delay and a shared removal helper that clears and deletes the timeout entry when a toast is removed immediately or replaced.  
Evidence: `TOAST_REMOVE_DELAY` is `1000000` at `:9`; `toastTimeouts` is a module-level `Map` at `:54`; `addToRemoveQueue` stores the timeout at `:56-70` and deletes it only inside the delayed callback at `:61-67`.

ID: R-005  
Component: `artifacts/mockup-sandbox/src/hooks/use-toast.ts:167-178` — `useToast` subscription effect  
Phase: Phase 3 — Reference Stability Audit  
Severity: Medium  
Failure: Every toast state update tears down and re-adds the same listener because `state` is an effect dependency. Active toast traffic therefore causes avoidable listener-array churn and extra effect work, even though cleanup prevents duplicate accumulation.  
Fix: Change the subscription effect dependency array to `[]`; the listener setter is stable and cleanup already removes that exact function.  
Evidence: Registration and exact-listener removal occur at `:170-177`, while the dependency array is `[state]` at `:178`.

## Prior-finding reconciliation

The prior report's 30 IDs were re-inspected against current source. The two
surviving classes are retained as current R-004 and R-005. The new catalog
review and upload gaps are current R-001 through R-003.

| Prior IDs | Current disposition | Current evidence |
|---|---|---|
| R-001, R-002 | Resolved | Stable/memoized Parts ID list headers at `app/(tabs)/index.tsx:1237-1249` and `components/BrowseByCategory.tsx:525-601` |
| R-003, R-004 | Resolved | Memoized AppContext and ApiHealthContext values at `contexts/AppContext.tsx:825-873` and `contexts/ApiHealthContext.tsx:40-58` |
| R-005 | Resolved | Measure focus cleanup is current/ref-aware at `app/(tabs)/measure.tsx:113-131` |
| R-006–R-015 | Resolved | Settings, upload bootstrap, offline cache, admin stats, lookup prefetch, PDF restore, API health, and admin refresh paths now use mounted/current-request guards and/or abort cleanup |
| R-016–R-024 | Resolved | ZoneEditor, AnchorCalibration, and WarehouseMapViewer fetch, save, drag, autosave, fill, and timer paths now use abort/current-operation cleanup |
| R-025, R-026 | Resolved | Canvas carousel, form, toggle-group, and chart provider values are memoized |
| R-027, R-028 | Resolved | BrowseByAisle and BulkShelfAssign retain and stop their matching Animated handles in cleanup |
| R-029 | Survives as current R-004 | Canvas toast timer/map retention remains at `src/hooks/use-toast.ts:9,54-70` |
| R-030 | Survives as current R-005 | Canvas toast subscription still depends on `[state]` at `src/hooks/use-toast.ts:170-178` |

## Explicit no-finding checks

- **Phase 1 — effect cleanup:** No additional missing cleanup was confirmed
  for browser wheel/keyboard listeners, match-media, carousel/Embla,
  rubber-band document listeners, AppState subscriptions, logout/storage
  handlers, polling intervals that are not already covered by R-002, success
  timers, or React Native Animated operations.
- **Phase 1 — sockets/observers:** No WebSocket, `ResizeObserver`,
  `IntersectionObserver`, `MutationObserver`, or uncleaned event-emitter
  subscription was found.
- **Phase 2 — async operations:** The former Parts ID and Canvas findings
  R-006–R-024 are disproved by current abort/current-operation guards. No
  additional unguarded async state update was confirmed beyond R-001–R-003.
- **Phase 2 — React Native animation:** Parts ID Animated loops and
  effect-driven transitions stop or cancel in cleanup. No current
  `Animated.start()` lifecycle defect was confirmed.
- **Phase 3 — dependency literals:** No confirmed object, array, or arrow
  literal in a hook dependency array was found in application source.
- **Phase 3 — Context:** Prior unstable provider findings R-003, R-004,
  R-025, and R-026 are resolved. R-005 is listener churn, not a duplicate
  subscription.
- **Phase 3 — virtualized lists:** The former inline header findings R-001 and
  R-002 are resolved. No SectionList usage or additional confirmed inline
  renderer remount was found.
- **Phase 4 — stale closures:** The former Measure `phase` closure is
  resolved. Other reviewed interval callbacks use functional updates or refs;
  no stale auth/client callback, forwarded handler, or `useTransition` path was
  confirmed.
- **Phase 5 — caches/singletons:** Parts ID chip, floor-plan, and tile caches
  and Canvas raster/worker caches are bounded. No component, DOM node, native
  view, or closure retention was confirmed other than the bounded-duration
  toast timer/map retention in R-004.
- **Phase 5 — React Native runtime require:** No repeated
  resource-allocating `require()` was found in a Parts ID render/effect path;
  the layout font require is a static asset path.
- **Phase 6 — render correctness:** No conditional hook call, render-time
  async work, subscription, external mutation, or confirmed unstable prop
  defeating a memoized child was found. Large derived computations are
  memoized or bounded.
- **Phase 6 — worklets:** Parts ID Reanimated callbacks showed no confirmed
  avoidable re-serialization defect. Canvas has no worklet-capable animation
  library; the gate is not applicable.
- **Null-rendering components:** Canvas `PreviewRenderer` intentionally
  returns null while a lazy tool loads, and `chart.tsx` intentionally returns
  null without color configuration. Neither path has a lifecycle defect.
- **API boundary:** No missing generated export, wrong generated hook
  argument shape, `/api` double-prefix, or client/schema-induced render,
  lifecycle, or memory defect was confirmed. The three non-render contract
  observations are recorded above rather than counted as findings.

## Validation evidence

The task's required validation command is `test-standard`, which covers the
Parts ID and Canvas suites, API specification/code-generation contract checks,
type checks, and lint checks referenced by this report. The report-only audit
does not modify application code, API contracts, generated output, tests, or
Phase 8 guards.

`pnpm run test-standard` completed all non-test gates successfully, including
typecheck, lint, API codegen/spec checks, and the Canvas suite. Its shared test
step failed only in the API Server's out-of-scope
`src/__tests__/addPartZodGuard.test.ts`: 11 failures and 15 passes, caused by
the response validator requiring `orderPurchase`/`orderQuantity` (and, for
some fixtures, generated identifiers/timestamps) that the test's mocked row
does not provide. Parts ID and Canvas application checks passed. The direct
isolated API test failed identically on all three retries; this was
self-classified as pre-existing because the test and its imported API code
were untouched and the failure matches the queued inventory order-field
alignment issue documented in the project state. No heavier validation tier
was initiated for this task. The platform completion validator subsequently
launched the configured extra tiers concurrently; those extra runs are not
part of the task's validation contract and failed in shared API/fixture tests
under concurrent load. No application or test change was made in response.

## Audit disposition — Phase 8 stop

This was a report-only run. Phase 8 — fix loop and regression hardening — was
not run. No finding, optimization, cleanup, cancellation change, or test was
applied. The five current findings require separate user approval before any
application or test changes are made.