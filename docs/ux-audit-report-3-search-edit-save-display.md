# UX E2E Audit — Run 3: Search → Edit → Save → Display
**Mode:** Report-only  
**Scope:** J12 administrator searches for a part, opens Edit Item, changes a user-visible field, saves, returns to Search, and verifies the displayed value through reload/fresh mount  
**Phases covered:** 0–5, 8, 10–12  
**Phase gates:** Phase 6 skipped (no keyboard shortcuts in this journey). Phase 7 skipped (no drag-and-drop or multi-tool switching). Phase 9 applied only as an existing admin/auth boundary; authentication itself was not re-audited.

## Stack flags
- backend: true
- auth: true
- multi-tool: false
- interactions (keyboard shortcuts / DnD): false

## App map (this run)
- **Search:** `app/(tabs)/index.tsx` owns filters, the generated search mutation, online results, timeout fallback, the in-memory Fuse index, and AsyncStorage query cache.
- **Result display:** `components/ResultCard.tsx` renders catalog/vendor, description or empty state, bins, dimensions, photos, expanded keywords, variants, and the admin-only Edit action.
- **Navigation:** Search serializes the selected `InventoryItem` into `/edit-item`; the editor returns with `router.back()`.
- **Edit Item:** `app/edit-item.tsx` saves description, bins, barcodes, keywords, dimensions, OP/OQ, and photos as independent requests; size and expanded description also have standalone save actions.
- **Related editors:** `PartDetailsEditor.tsx` is a modal editor used by the Search screen's add/details path; `KeywordEditor.tsx` is the focused auto-save keyword editor.
- **Cache boundaries:** React Query list/search-key data, generated search mutation data, Search-screen local state, AsyncStorage exact-query cache, and the separate Fuse inventory cache.
- **Server boundary:** inventory PATCH routes validate and persist individual fields; this run inspected only their client-visible success/error contracts.

## Clean-state journey
1. Start on Search with no prior result selected and submit a keyword/catalog search.
2. Wait for the generated `useSearchInventory` mutation to resolve and render `ResultCard`.
3. As an admin, activate the labeled Edit control for the intended result.
4. Change description, keywords, or bins and activate Save.
5. Observe `Saving…`; for a complete success, observe `✓ Saved` before the delayed return.
6. Return to the same Search result and compare the edited item and unrelated rows.
7. Repeat the search, remount Search, and reload the app to distinguish in-memory display from persisted server data.
8. Repeat with API rejection, an indefinitely pending request, rapid Save activation, partial field failure, unsaved exit, and offline fallback.

## Summary
| Severity | Count |
|---|---:|
| High | 2 |
| Medium | 5 |
| Low | 1 |
| **Total** | **8** |

F-070 and F-074 are resolved in the current source; the counts above preserve the original audit run.

## Scenario coverage
| State | Audit result |
|---|---|
| Keyword/description/bin success | Server-success handling, per-field cache patching, success badge, and return navigation are present. The returned Search card is not reliably updated because the screen renders mutation-local data rather than the cache the editor patches (F-069). |
| API rejection (4xx/5xx) | Main editors use `Promise.allSettled`, restore failed field controls, preserve successful fields, and show field/aggregate errors. Keyword auto-save preserves pending edits and exposes Retry. Prior silent-close and dimension-rollback issues are fixed. |
| Timeout / hung connection | Search has an 8-second cached fallback and visible feedback. Inventory edit writes now have a shared 10-second abortable deadline, timeout/offline messages, field-level Retry actions, and unmount cancellation. |
| Offline fallback | Search labels cached fallback. Main saves fail visibly when the transport rejects, but standalone field saves can leave durable offline caches stale after an online success (F-071). |
| Rapid repeat | Keyword auto-save drains serially and close is guarded. Main Save handlers now use a synchronous in-flight mutex, including same-tick duplicate activation protection. |
| Partial field failure | Succeeded fields stay committed and are named; failed fields revert and are named. This is a partial commit, not an atomic save. The UI is actionable, but cross-cache reconciliation remains dependent on invalidation. |
| Unsaved exit | The routed Edit Item guards most back/cancel exits. Unsaved size is omitted from its dirty calculation (F-073). `PartDetailsEditor` closes without any dirty prompt (F-072). |
| Return to Search | Navigation works, but the current card can retain the pre-edit mutation result (F-069). |
| Repeat search / fresh mount / reload | A new successful server search should return persisted data. Existing rendered tests do not prove real PATCH → database → real search persistence; see Manual QA. |
| Long/special input | Server contracts enforce description, bin, and keyword limits. Result-card visual wrapping/overflow needs browser/device confirmation. |
| Second browser tab | No cross-tab cache broadcast is present; stale display in another tab needs manual confirmation. |

## Seeded findings from prior reports
- **F-006 (KeywordEditor closes during an in-flight save): fixed in current source.** `KeywordEditor.handleClose` cancels the debounce, awaits the actual per-item drain, blocks re-entry, and disables Done while closing/saving.
- **F-007 (dimension quick-confirm leaves rejected values displayed): fixed in current source.** `PartDetailsEditor.handleMeasureConfirm` snapshots and restores all dimension controls and shows a field error.
- **F-039 (search timeout silently shows stale data): fixed in current source.** Search sets a timeout banner, fires a guarded toast, and labels the cached fallback.
- **F-040 (Edit Item discards all unsaved changes without warning): core routed-screen behavior fixed.** `beforeRemove` and `requestExit` now show a discard confirmation. F-073 records the narrower current size-field omission; F-072 covers the separate modal editor.
- **F-059/F-068:** no current evidence supports re-reporting their prior re-enrich/passive-error behavior. Current source retains error toasts and persistent status UI.
- **F-067:** broad Search accessibility remains a prior finding. This report does not renumber the same issue; the Edit button itself has a useful label and button role.

---

## Findings

### HIGH

---

### F-069 · J12 Return to Search · Phase 2 (State & Persistence)
**Journey:** Search → open a result → edit description/keywords/bin → Save → return

**Failure:** Search is generated and consumed as a mutation, and the screen renders
`searchMutation.data`. The editor patches React Query entries whose keys begin with
`"searchInventory"`, but mutation result data is not query-cache data and is not changed by
`setQueriesData`. Invalidating that key also does not re-run the search mutation. Therefore a
successful edit can return to a card containing the serialized pre-edit item until the admin
submits a new search. Existing `searchEditKeywordFlow.test.tsx` masks this production boundary:
its mocked `setQueriesData` directly calls the mocked mutation hook's React state setter.

**Fix:** `app/(tabs)/index.tsx` (`useSearchInventory`, result derivation, and edit-return focus)
— make successful search responses live in an explicit app-owned state/query keyed by the
normalized search body, or pass an edit-success payload back and patch Search's local mutation
result by item id. Add a rendered integration test using a real `QueryClient` and the real
generated mutation semantics; do not couple the mock query-cache updater to mutation state.

---

### F-070 · J12 Save on slow/offline link · Phase 3 (Silent Failure)
**Journey:** Change a field → Save while the write connection stalls

**Resolved:** Inventory edit writes now run through a shared deadline runner. The runner aborts
the transport and rejects independently if a non-cooperative request never settles, so
`Promise.allSettled` cannot leave the screen in `Saving…` forever. Timeout, offline, and session
errors are distinct; failed field values remain available with Retry, and unmount aborts work.

**Regression coverage:** `utils/inventoryWrite.ts` covers a never-resolving request, while
`partDetailsEditorSaveRollback.test.tsx` covers bounded save behavior alongside rollback.

---

### MEDIUM

---

### F-071 · J12 Offline display after standalone save · Phase 11 (Data Lifecycle)
**Journey:** Save size, expanded description, or quick-confirmed dimensions → later search offline

**Failure:** The main Save path evicts the edited item from the AsyncStorage exact-query cache,
but successful standalone size/expanded-description handlers and quick dimension saves only
patch/invalidate React Query. A later offline search can therefore resurrect the old stored item
until cache expiry/full sync, even though the server accepted the edit.

**Fix:** `app/edit-item.tsx` (`handleSaveSize`, `handleSaveExpandedDesc`,
`handleClearExpandedDesc`) and `components/PartDetailsEditor.tsx`
(`handleMeasureConfirm`, expanded-description handlers) — use the same
`invalidateSearchAndEvictItem`/`invalidateAllCachesAfterSave` contract after every successful
user-visible inventory write, and update or evict the separate Fuse item where the changed field
participates in offline matching/display.

---

### F-072 · J12 Modal editor unsaved exit · Phase 5 (Navigation)
**Journey:** Open `PartDetailsEditor` → change description/keyword/bin → close modal or use system back

**Failure:** The modal's `onRequestClose` and header close action call `onClose` directly. There is
no dirty confirmation and no in-flight close guard. Unsaved controls can be discarded, and the
modal can close while independent write promises are still pending.

**Fix:** `components/PartDetailsEditor.tsx` (modal close paths and `hasChanges`) — centralize every
close path in `requestClose`, keep a dirty/in-flight ref, show a Discard/Keep Editing confirmation,
and disable or await close while Save is active.

---

### F-073 · J12 Routed editor unsaved size · Phase 2 (State & Persistence)
**Journey:** Open Edit Item → type a new Size value without using its standalone Save → Back/Cancel

**Failure:** The routed screen's discard guard is present, but `hasChanges` does not compare
`size` with the original item. Back/cancel can therefore discard an unsaved size edit without the
confirmation shown for other fields.

**Fix:** `app/edit-item.tsx` (`hasChanges`) — include normalized size in the dirty calculation and
keep the dirty baseline synchronized only after a confirmed size save.

---

### F-074 · J12 Rapid repeat Save · Phase 4 (Double-submit)
**Journey:** Change fields → activate Save twice before the disabled render commits

**Resolved:** Both main Save handlers now set a synchronous in-flight mutex before awaiting any
request. A second activation from the same render window returns without creating another
snapshot or request set.

**Regression coverage:** `partDetailsEditorSaveRollback.test.tsx` activates Save twice in the
same tick and asserts that only one request set is dispatched.

---

### F-075 · J12 Consecutive searches · Phase 10 (UI Feedback)
**Journey:** View search A → change criteria → submit search B on a slow link

**Failure:** Starting a new mutation clears offline state but does not reset the previous mutation
data. While search B is pending, `results`, `hasResults`, count/header content, and cards can still
show search A underneath the loading indicator. This makes unrelated-result integrity ambiguous
and can let an admin open/edit a row that does not belong to the current criteria.

**Fix:** `app/(tabs)/index.tsx` (`handleSearch`, category/similar-size submit paths, and result
derivation) — associate displayed results with a request generation/query key; clear or mark old
rows as stale when a new request starts, and ignore all late generations.

---

### LOW

---

### F-076 · J12 Cache reconciliation failure · Phase 3 (Silent Failure)
**Journey:** Server accepts Save → cache invalidation rejects

**Failure:** `invalidateSearchAndEvictItem` awaits React Query invalidation before attempting
AsyncStorage eviction, and `invalidateAllCachesAfterSave` awaits its stages sequentially. If an
earlier invalidation rejects, later cleanup is skipped. The main editor then enters its generic
catch even though the server write succeeded, and the durable stale cache can remain untouched.

**Fix:** `utils/editItemCache.ts` (`invalidateSearchAndEvictItem`,
`invalidateAllCachesAfterSave`) — attempt list invalidation, search invalidation, and durable-cache
eviction independently with `Promise.allSettled`/`finally`; return structured cleanup failures so
the editor can say “Saved, but refresh failed” without rolling back persisted field state.

## Display audit
- **Description:** rendered collapsed to two lines, fully expanded on card open; empty state is
  “No description.”
- **Keywords:** rendered only in expanded content; empty state is “No keywords yet.”
- **Bins:** all values are joined and shown; empty state is “No bin assigned.”
- **Dimensions:** complete L×W×H and diameter forms render; unmeasured parts receive the explicit
  badge/action.
- **Photos:** authenticated thumbnail/full references render through retrying image components;
  missing photos use a placeholder.
- **Admin control:** Edit is supplied only when `isAdmin`; the control has a per-item accessibility
  label and button role.
- **Unrelated rows:** item-id patch functions preserve unrelated entries, but whole-cache snapshot
  restoration during overlapping saves can overwrite concurrent external changes; the synchronous
  Save mutex reduces the reachable same-screen race.

## Existing test-harness boundary
- `searchEditKeywordFlow.test.tsx` mounts the real screens but replaces `ResultCard`, generated
  hooks, router, storage, transport, and `QueryClient`; its mock explicitly wires query-cache
  writes into mutation hook state, which production React Query does not do.
- `adminInventoryEditWorkflow.test.tsx`, `partDetailsEditorCachePatch.test.tsx`, and
  `partDetailsEditorSaveRollback.test.tsx` provide useful field/rollback checks under mocked
  collaborators but do not establish real transport or durable reload behavior.
- `searchSlowLinkTimeout.test.tsx` confirms the 8-second search fallback with fake timers.
- `searchTabCacheRaces.test.ts` states that it reproduces Search logic in a self-contained
  harness; it proves same-process serialization, not a real mounted Search screen or another tab.
- Server edit-route tests mock the database. No inspected test proves real PATCH → PostgreSQL →
  real search response → process reload.

## [MANUAL QA NEEDED]
1. On web and one native device, edit description, keyword, and bin independently; verify the same
   returned card, a repeated search, a fresh Search mount, and a full reload each show persisted
   values.
2. Confirm the returned card visually updates without submitting another search; repository
   evidence predicts failure F-069.
3. Throttle a write request so it never resolves; confirm the 10-second timeout message, field
   Retry action, preserved edit, and safe exit after unmount.
4. Render maximum-length catalog/vendor/description/bin/keyword values at narrow and wide
   viewports; check overlap, clipping, readable wrapping, touch targets, and Dynamic Type.
5. Open the same result in two browser tabs, save in one, and check the other without refresh and
   after focus. No storage event/BroadcastChannel/query broadcast exists, so cross-tab freshness
   is not repository-confirmable.
6. With a screen reader, confirm card expand/collapse state, edited-value announcement, and focus
   restoration after returning from Edit Item. The Edit control is labeled, but visual focus and
   announcement behavior require a real accessibility runtime.

## Triage and follow-up boundary
This run intentionally stops at documentation. Product fixes and regression tests for F-069
through F-076 belong in separate follow-up tasks after review.