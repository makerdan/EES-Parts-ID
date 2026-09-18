---
name: edit-part-save-flow
description: >-
  Trace and plan fixes for reports that editing a part isn't saving, Save
  Details doesn't work, the edit part flow is broken, or field changes aren't
  persisting. Follow the complete search, select, edit, multi-field save, and
  persistence-verification routine.
---

# Edit Part Save Flow

Use this skill to investigate the concrete user journey from finding a part to
confirming that several edited values are actually stored and displayed. It is
deliberately narrower than a general bug audit: it follows one end-to-end
inventory editing flow and checks the client request fan-out, each server write
boundary, cache reconciliation, and failure behavior.

## Trigger

Invoke this skill when a request says that:

- editing a part isn't saving;
- **Save Details** doesn't work or appears to do nothing;
- the team needs to check the Edit Part flow;
- one or more field changes aren't persisting after an edit; or
- a report says that one field saves while another field is lost, reverted, or
  shown incorrectly.

This is distinct from `bug-audit`: use `bug-audit` for a broad report across
the application or for unrelated defects. Use this skill when the reported
problem is specifically the Search → Edit Part → Save Details journey.

## Scope and role

This skill identifies the investigation routine and produces a plan. It does
not implement fixes, modify the Edit Part feature, or create an automated
end-to-end script. The Planner should record the evidence, affected
boundaries, proposed change, and validation plan for a later implementation
task.

MFA, authentication, and administrator-authorization checking are explicitly
out of scope here. Do not expand this routine into an MFA or access-control
review; that work belongs in a separate task.

Compose the resulting plan with:

- `writing-plans` for the ordered implementation plan and completion criteria;
- `regression-guard` when the proposed work changes existing save, validation,
  persistence, cache, or error behavior; and
- `failure-gate` for documenting pre-existing test failures and selecting the
  one permitted validation tier.

## Source map

Start by locating the current equivalents of these owners rather than assuming
the paths have not moved:

| Journey stage | Current Parts ID owner | What to inspect |
|---|---|---|
| Search | `artifacts/parts-id/app/(tabs)/index.tsx` | Search input/button, request body, result data, and the callback passed to each result |
| Result card | `artifacts/parts-id/components/ResultCard.tsx` | Card selection/open behavior and the Edit Part action's item identity |
| Edit screen | `artifacts/parts-id/app/edit-item.tsx` | Local field state, baseline comparison, Save Details handler, write fan-out, and navigation |
| Cache/display reconciliation | `artifacts/parts-id/utils/editItemCache.ts` plus the screen's query usage | How list/search caches are patched, invalidated, or restored |
| Client/server contracts | `@workspace/api-client-react` generated operations and the API route modules | Mutation URLs, payload shapes, response parsing, and validation schemas |
| Regression evidence | `artifacts/parts-id/__tests__/searchEditKeywordFlow.test.tsx` and the API inventory-edit tests | Multi-field success, partial failure, invalid input, and database persistence assertions |

If the project has renamed these files, follow imports and route registration
to the actual owners and record those paths in the plan.

## Required journey trace

Trace this exact sequence. Do not stop after proving that a button was tapped
or that a request was sent.

### 1. Search for a part

Use a deterministic part identifier or keyword that produces a known result.
Check:

- which Search screen owns the input and submit action;
- how the entered value is normalized and put into the search request;
- which response item is rendered in the result list;
- whether the result card displays a stable item id and the starting values that
  will later be compared; and
- whether the search result is held in React Query, another cache, or local
  state.

Record the exact item identity and baseline values before editing. Include at
least the description, bins or keywords, OP/OQ, and dimensions when those
fields are available.

### 2. Select the result card and open Edit Part

Select the intended result card, then use its Edit Part action. Check:

- which component owns the card press and which callback opens the editor;
- whether the serialized or selected item passed to the editor is the same
  item returned by search;
- whether the Edit Part screen initializes every editable field from that item;
  and
- whether a stale route parameter, stale cache entry, or wrong result index can
  make the editor start from the wrong baseline.

The investigation must prove the id and baseline values remain consistent
across the Search screen, result card, route/navigation payload, and editor.

### 3. Change multiple values before saving

Change at least two independent field groups in one editing session. Include
OP/OQ as a concrete case when those controls exist: change order purchase and
order quantity to valid non-negative whole numbers, such as OP `7` and OQ `8`.
Also change at least one of description, bins, keywords, dimensions, or a
photo so that the save fan-out is exercised.

For every changed field, check:

- the input has a distinct controlled state value;
- the editor compares it with the current saved baseline, not only a stale
  render-time value;
- trimming, empty values, numeric parsing, null clearing, deduplication, and
  unit conversion happen exactly once and at the intended boundary; and
- the user-entered value is still available for retry if its write fails.

Do not treat a changed input or a computed total as proof of persistence.

### 4. Tap Save Details and inventory every write

Identify the exact `Save Details` handler and list one request for every
changed field. Current behavior uses independent PATCH requests; verify the
current implementation before relying on this list:

| Field group | Expected endpoint/body to verify | Client-side checks to verify |
|---|---|---|
| Description | `PATCH /inventory/:id/description` with `{ description }` | Trimmed text and no request when unchanged |
| Bins | `PATCH /inventory/:id/bins` with `{ binLocations }` | Pending text is included, duplicates/empty entries are handled, and the mutation response is consumed |
| Barcodes | `PATCH /inventory/:id/barcodes` with `{ barcodes }` | Pending text is included and unchanged arrays do not write |
| Keywords | `PATCH /inventory/:id/keywords` with `{ keywords }` | Pending keyword is included in normalized form and the mutation response is consumed |
| OP/OQ | `PATCH /inventory/:id/order` with `{ orderPurchase, orderQuantity }` | Both values are sent together, parsed as safe non-negative integers, and no write occurs for invalid input |
| Dimensions | `PATCH /inventory/:id/dimensions` with length, width, height, and diameter values or nulls | Values are parsed in the screen's unit, compared with the current dimensions, and null clears are intentional |
| Photos | `PATCH /inventory/:id/photo` with an upload or `{ remove: true, slot }` | Slot 1 and slot 2 are independent and returned URLs are captured before cache updates |

The size and expanded-description controls have separate save actions in the
current editor. Do not incorrectly attribute those requests to Save Details;
include them only if the reported journey uses those controls.

Check whether writes are issued concurrently, sequentially, or through a
shared mutation helper. For concurrent writes, inspect how results are paired
back to field names and ensure one rejected request cannot be mistaken for
another field's success.

### 5. Trace server validation and persistence

For each request that Save Details sends, follow the route from registration to
the database update and response schema. Confirm all of the following:

1. The route receives the intended item id and request body.
2. The body rejects malformed types and invalid values with a non-success
   response that the client can display.
3. Normalization rules are explicit and do not silently convert a failed edit
   into an unrelated value.
4. The database update targets only the intended item and field(s).
5. JSON fields use the intended merge/replace behavior. In particular, a
   dimensions update must not erase dimensions that were omitted from a
   partial request.
6. A missing item, database failure, or response-schema failure becomes a
   failed write rather than a false success.
7. The successful response represents the stored value, not merely the
   submitted request.

For the current routes, verify the concrete invariants when applicable:

- description is a string trimmed to at most 500 characters;
- bins are strings, capped in count and per-entry length, then trimmed,
  emptied, and case-insensitively deduplicated;
- keywords are strings, capped in count and per-entry length, then trimmed and
  empty entries are dropped;
- barcodes are string arrays normalized by trimming, dropping empty entries,
  and removing duplicates;
- OP and OQ are both required safe non-negative integers;
- dimensions are finite non-negative millimetre values no larger than the
  server limit, or null, and the stored JSON is merged for partial updates;
  and
- photos either return the stored URL for the requested slot or confirm the
  requested removal.

These are data-boundary checks, not an authorization review.

### 6. Verify successful display and actual persistence

After a successful response, check both immediate UI state and durable state:

- the editor's committed item reference reflects every successful field;
- list and search query caches receive a complete item patch without changing
  unrelated result cards;
- derived values such as Total OP/OQ are recomputed from the saved values;
- the editor navigates away only after every requested write succeeds;
- the result card shows every changed value after cache reconciliation; and
- a refetch, remount, or direct database-backed API read returns the same values
  after the cache is cleared or bypassed.

The final check is required. A green button, a 200 response, or an updated
in-memory card alone does not establish that the data persisted.

### 7. Exercise and document a failed field save

Repeat the same multi-field journey while making one field request fail. Use a
field-specific response error, not only a network error, when possible. Check
that:

- the failed field is named in the field-level error and the overall save
  status;
- successful fields remain visible and are applied to caches;
- the failed field is not presented as persisted in the editor, result card,
  or derived totals;
- the user's edit is not silently discarded: the field either remains as the
  attempted value for retry or is deliberately restored with a clear reason;
- cached data is restored to its pre-edit snapshot before successful-field
  patches are reapplied;
- unrelated result cards remain unchanged;
- navigation does not occur while any field is unresolved; and
- retrying the failed field does not resend unrelated fields unless the
  current design explicitly requires it.

Also exercise invalid OP/OQ, such as a negative or fractional value. Confirm
that the editor reports the validation error, sends no order request, and
leaves the cached total unchanged.

## Evidence and plan output

The investigation result should include:

1. the reproduced journey and exact item/field values used;
2. a stage-by-stage owner map from Search screen through route, editor,
   endpoint, database update, response, and cache;
3. a request matrix showing every changed field and its actual payload;
4. the server validation and persistence evidence for each request;
5. the success and failed-field display/persistence results;
6. the smallest likely fault boundary and a proposed fix direction; and
7. the regression guard and the single validation command for the
   implementation plan.

If the journey cannot be completed, state the first failing stage and preserve
the evidence needed to distinguish a navigation problem, request construction
problem, server validation/persistence problem, cache problem, or display
problem.

Do not fix code while producing this output. Hand the evidence to
`writing-plans`, then let `regression-guard` and `failure-gate` govern the
implementation task's regression assertions and validation.