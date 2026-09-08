# UX E2E — Read-only Query Tools

**Journey:** Warehouse → query/inventory/floor-plan tools → run/read/export/upload → retry or return  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/(tabs)/upload.tsx` owns the read-only SQL editor, `/admin/query` execution and CSV/XLSX export, paginated inventory query, floor-plan picker/upload, and links to the admin map tools. The UI displays write-keyword warnings and disables query execution while running.

## Persistence and cross-context checks

Query text/results are in-memory and cleared on remount; inventory is server-backed through `useListInventory`. Floor-plan upload posts SVG content and reports success/error. `[MANUAL QA NEEDED]` verify web/native file picking, large query results, export downloads/share, and protected deep-link behavior.

## Failure, retry, navigation, accessibility

Query has empty/error/results states and export errors. Query rows are rendered from dynamic columns/values. Inventory has Load More but no visible query failure recovery in the scoped excerpt. Floor-plan handling validates server response but does not validate the selected file before reading/posting.

## Findings

### HIGH

#### F-103 · Query result integrity · Phase 3 (Silent Failure)

**Failure:** Query result rendering assumes `columns` and every row value are safe to render as text. A malformed or partially shaped server response can throw during `queryResult.columns.map`/cell rendering or stringify as misleading object text, leaving the admin with a blank/crashed tool instead of a clear invalid-result error. This is user-visible even though the API is read-only.

**Fix:** `app/(tabs)/upload.tsx` query result parser/rendering — validate the complete response with a schema before committing it, normalize null/object/long values for display, and show a retryable “Results could not be displayed” state without weakening the no-write guard.

### MEDIUM

#### F-104 · Query high-volume results · Phase 10 (UI Feedback)

**Failure:** The query tool renders all returned rows in one scroll container and does not impose a client-visible row cap or pagination contract. A valid high-volume response can make the admin tab unresponsive and provides no progress/limit explanation, while export still operates on the unbounded result.

**Fix:** `app/(tabs)/upload.tsx` query result view and API contract — enforce a bounded display page with explicit row-limit copy, virtualize/paginate rows, and make export limits/continuation behavior explicit.

#### F-105 · Floor-plan upload validation · Phase 4 (Error & Edge Case)

**Failure:** The selected document is read and posted based on the picker result; client-side type/size/content validation is not established before upload. A wrong file or oversized SVG waits for a server rejection, with no early explanation of accepted limits.

**Fix:** `app/(tabs)/upload.tsx` floor-plan picker/upload path — validate extension/MIME, byte size, and SVG shape before reading/posting; show field-level rejection and retain the selected file for correction/retry.

### LOW

#### F-106 · Query and tool controls · Phase 12 (Accessibility)

**Failure:** Query help, run, export, Load More, Go to Import, and floor-plan actions rely on visible text or icon/text combinations without consistently declared labels and busy/disabled state. Dynamic result headers/cells also lack a table-like semantic announcement.

**Fix:** `app/(tabs)/upload.tsx` query/inventory/floor-plan controls — add labels, roles, busy/disabled state, and accessible row/column context; keep the read-only warning discoverable before execution.

## Seed/context

Warehouse Map rendering and floor-plan infrastructure work are out of scope or owned separately. This report covers the admin tool entry points, validation, result handling, and recovery affordances.

## [MANUAL QA NEEDED]

- Malformed API payload, empty result, long values, and high-volume result behavior.
- CSV/XLSX web download and native share failure.
- File picker MIME/size/content edge cases on web and native.
- Keyboard, screen-reader, zoom, and font-scale use of the query editor.

## Report-only stop

No fix or test change was made.
