# Admin Part Search and Save Confirmation

**Date:** 2026-09-15  
**Result:** Automated confirmation passed, including real test-database persistence; live administrator interaction remains manual QA
**Scope:** Existing-part search, exact-part edit selection, one user-visible field save, returned-result refresh, repeat search, and fresh mount/reload  
**Excluded:** Regular-user permissions and unrelated inventory workflows

## Confirmation environment

| Surface | Environment | Data boundary |
|---|---|---|
| Parts ID client tests | Local Jest, React Native test renderer, Node test environment | Deterministic mocked search and authenticated write responses |
| API inventory route tests | Local Jest/Supertest with `DATABASE_ENV=test` | Route-contract suite with mocked DB plus integration suite using real test PostgreSQL |
| Live administrator journey | Not run | No approved administrator test account and designated reversible non-production inventory record were available |

No production data was read or changed. No inventory record required restoration.

## Current application path

The earlier audit in `docs/ux-audit-report-3-search-edit-save-display.md` reported that Search rendered mutation-local data and could show the pre-edit item after returning from Edit Item. That is not the current path.

Current Search behavior stores the active response under the app-owned `["searchInventory", "active"]` query key. Edit Item patches matching list/search entries by item ID before invalidation, reconciles the offline query and Fuse caches, shows a saved state, and returns after a 500 ms delay. Search subscribes to matching query-cache updates and derives its displayed results from the active query entry.

## Focused automated checks

### Search to edit and immediate returned-result refresh

Command:

```sh
cd artifacts/parts-id && pnpm exec jest --runInBand --runTestsByPath \
  __tests__/searchEditKeywordFlow.test.tsx \
  __tests__/editSaveE2E.test.ts
```

Result: **PASS — 2 suites, 25 tests**

Tested user-visible field: **keyword**, changed from `old keyword` to `replacement keyword` on fixture catalog `PART-X` (item ID 42).

Observed proof:

- Search submits the expected inventory search request.
- Activating Edit serializes and opens the exact first result, item ID 42 / `PART-X`.
- Save sends the normalized replacement keyword for item ID 42.
- The mounted Search result changes immediately to the replacement keyword without another search.
- The unrelated `OTHER-PART` result remains unchanged.
- Edit Item waits for the saved interval and then invokes return navigation.
- Save-operation coverage confirms successful write handling, changed-field payloads, cache invalidation, offline search-cache eviction, and failure rollback behavior.

Evidence boundary:

- The screens and production cache utilities are mounted/executed, but transport, storage, router, result card, and generated mutation hooks are controlled test doubles.
- This check does not prove a real server write or a later server search.

### Saved feedback and fresh editor mount

Command:

```sh
cd artifacts/parts-id && pnpm exec jest --runInBand --runTestsByPath \
  __tests__/adminInventoryEditWorkflow.test.tsx
```

Result: **PASS — 1 suite, 4 tests**

Tested user-visible field: **description**, changed to `Persisted workflow description`.

Observed proof:

- The mounted editor issues the authenticated write.
- Successful save patches caches and presents the saved state.
- A fresh editor mount initialized from the simulated persisted response displays `Persisted workflow description`.

Evidence boundary:

- The reload response is simulated by the test harness. This proves client handling across remount, not PostgreSQL durability.
- Regular-user assertions present in this pre-existing suite were not expanded or re-audited for this task.

### API write route

Command:

```sh
cd artifacts/api-server && DATABASE_ENV=test pnpm exec jest --runInBand \
  --runTestsByPath src/__tests__/inventoryEditRoutes.test.ts
```

Result: **PASS — 1 suite, 41 tests**

Observed proof relevant to this journey:

- Inventory keyword PATCH accepts a valid array and returns HTTP 200 with the updated keyword array.
- Description, bin, dimension, and keyword routes enforce their request limits and return 404 when no updated row is returned.
- The Express route and response contract execute through Supertest.

Evidence boundary:

- `inventoryEditRoutes.test.ts` mocks `@workspace/db`; its successful `returning()` row is supplied by the test.
- This route-contract suite does not itself prove PostgreSQL persistence.

### Real database persistence, repeated search, and fresh app instance

Command:

```sh
cd artifacts/api-server && DATABASE_ENV=test pnpm exec jest --runInBand \
  --runTestsByPath __tests__/inventoryEdit.integration.test.ts
```

Result: **PASS — 1 suite, 57 tests**

Tested user-visible field: **keyword**, changed on a worker-qualified, non-production fixture
to `durable-search-keyword` and `admin-edit-confirmation`.

Observed proof:

- A real search through the Express route returns the seeded part and original keywords.
- An authenticated administrator PATCH writes the replacement keywords through the real route.
- A direct PostgreSQL read confirms both `aiKeywords` and `pinnedKeywords` were committed.
- Repeating the real search returns the same item ID with the replacement keywords.
- A newly created Express app instance mounts the production routes and returns the persisted
  replacement keywords from another real search.
- Suite cleanup restores the original keywords after the test and deletes the uniquely owned
  fixture after the suite.

Evidence boundary:

- This proves server persistence and fresh application readback in the isolated test database.
- Clerk is represented by the project’s test authentication adapter; no live Clerk account or
  production database is used.
- Visible taps, saved feedback, return navigation, and Search-card refresh remain client-test
  evidence rather than a live web/native session.

## Journey-stage result

| Journey stage | Result | Evidence |
|---|---|---|
| Search for a known existing part | Pass, automated | Mounted Search receives and displays deterministic results |
| Open the exact intended part | Pass, automated | Routed payload equals `PART-X`, item ID 42 |
| Change a user-visible field and save | Pass, automated | Keyword and description workflows send the expected writes |
| Clear completion feedback | Pass, automated | Mounted admin workflow reaches saved state |
| Return to expected part context | Pass, automated | Delayed back navigation fires and active Search card is patched |
| Updated value on returned result | Pass, automated | `replacement keyword` replaces `old keyword` immediately |
| Updated value after repeated server search | Pass, automated integration | Real PATCH followed by a separate real search returns the saved keywords |
| Updated value after fresh mount/reload | Pass, combined automated evidence; live interaction remains manual | Client remount reads simulated persisted data, while a newly created Express app reads the committed test-DB value |
| Durable PostgreSQL persistence | Pass, automated integration | Direct DB read and searches before and through a newly created app confirm the committed value |
| Live web/native administrator journey | **Not run** | Approved account and reversible non-production record unavailable |

## Manual QA needed

Use an approved administrator test account and a designated non-production record:

1. Search for the record by a unique catalog or keyword and note its item ID.
2. Open Edit and confirm the routed part is the same catalog and item ID.
3. Replace one reversible keyword with a unique temporary value.
4. Save and verify visible saved feedback followed by return to the same Search context.
5. Confirm the returned card shows the temporary keyword without submitting another search.
6. Repeat the same search and confirm the server result still shows the temporary keyword.
7. Remount Search or fully reload the app, repeat the search, and confirm the value remains.
8. Restore the original keyword, then repeat the search and reload checks to confirm restoration.

Record the platform, account approval state, catalog/item ID, before/temporary/restored values, and observed feedback. Do not run this against a production record unless the record owner explicitly approves the reversible edit.

## Findings and conclusion

No new defect was found in the focused automated checks.

The current repository provides automated proof for exact-result selection, successful
keyword/description write handling, clear saved state, return navigation, immediate active-result
refresh, unrelated-row preservation, a real test-database commit, repeated real search, and
readback through a newly created Express app instance.

Therefore the administrator search-and-save behavior is **confirmed by combined client and
real-database integration evidence**. A live web/native interaction remains optional manual QA
because no approved live administrator test account and reversible record were available.

## Required validation

Command:

```sh
pnpm run test-standard
```

Result: **The task-focused checks passed, but the standard tier was not fully green.**

The standard run produced these machine-readable summaries:

- Mockup sandbox: 1 of 1 suite passed; 74 of 74 tests passed.
- Parts ID: 177 of 179 suites passed; 2,276 of 2,280 tests passed.
- API server: 112 of 112 suites passed; 1,629 of 1,629 tests passed.

The Parts ID failures were:

- `partDetailsEditorMapIt.test.tsx`: two expanded-description success cases expected
  `invalidateQueries` once, and one dimensions success case expected
  `invalidateListCache` once, but the mapped cache helper mocks recorded zero calls.
- `editItemPendingBinKeyword.test.tsx`: the failed-dimensions retry case expected the edited
  value `10` to remain but received the original value `5`.

Per the task's flaky-test rule, every failing file was retried three times in isolation:

```sh
cd artifacts/parts-id
pnpm exec jest --runInBand --runTestsByPath \
  __tests__/partDetailsEditorMapIt.test.tsx

pnpm exec jest --runInBand --runTestsByPath \
  __tests__/editItemPendingBinKeyword.test.tsx
```

All three Parts ID isolation retries reproduced each failure class. This task changes only the
API integration test and this report; no failing Parts ID file or production dependency is in the
task diff. The failures are therefore pre-existing relative to this task and do not weaken the
passing focused evidence above.

During development, resetting Jest's module registry before the fresh-app read caused that read
to return HTTP 500 in a full suite. The confirmation test was corrected to create a new Express
instance and mount the production routes without reloading shared database modules. The complete
integration file then passed in isolation:

```sh
cd artifacts/api-server && DATABASE_ENV=test pnpm exec jest --runInBand \
  --runTestsByPath __tests__/inventoryEdit.integration.test.ts
```

Result after correction: **PASS — 1 suite, 57 tests**. The later standard-tier run also passed
all 112 API suites and all 1,629 API tests.

Recommended follow-up:

- Update the mapped PartDetailsEditor cache-helper mocks and assertions to match the current
  consolidated cache reconciliation contract.
- Align the failed-dimensions retry expectation with the intended rollback-versus-preserve
  behavior, then make the component and test enforce that single contract.