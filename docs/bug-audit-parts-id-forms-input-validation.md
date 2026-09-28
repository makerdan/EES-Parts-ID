# Bug & Error Audit Report — Parts ID Forms and Input Validation

**Scope:** User-entered forms and file/import input in Parts ID, traced from client controls through API validation to persistence. Focused on required values, formats, bounds, type/coercion, normalization, cross-field rules, submission timing, and validation feedback.
**Mode:** report-only
**Date:** 2026-09-25
**Stack:** TypeScript, React Native/Expo, React, Express, PostgreSQL/Drizzle, Zod, Jest, pnpm.
**Audit method:** Read-only source, test, task, and prior-report review. No production probes or behavior changes.

The canonical Bug Audit skill could not be located in the available canonical skill sources or skill search. No alternate/copied skill definition was used. This report follows the structure of the tracked Parts ID bug-audit reports and records that limitation.

## Summary

Three medium-severity input-validation defects were verified. The defects affect bulk CSV import, manual part dimensions, and map-anchor calibration coordinates. Closely related dimension parser instances are grouped in one finding and follow-up task. No application code or tests were changed.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 0 |

| # | Severity | Category | File:Line | One-line description | Follow-up |
|---|---|---|---|---|---|
| 1 | Medium | CSV structure and quote handling | `artifacts/api-server/src/routes/adminUpload.ts:55-79,98-120,377-432` | Unterminated quoted CSV fields are accepted and can overwrite inventory with truncated values. | #1931 — Stop malformed CSV files from silently changing inventory |
| 2 | Medium | Numeric format and coercion | `artifacts/parts-id/components/AddPartForm.tsx:28-31,174-187,349-387`; `artifacts/parts-id/components/PartDetailsEditor.tsx:74-76,733-762,1639-1672`; `artifacts/parts-id/app/edit-item.tsx:66-69,560-563,645-661,1472-1505` | Dimension input sanitization and `parseFloat` can silently turn malformed or negative text into a different saved measurement. | #1929 — Prevent part measurement typos from saving the wrong value |
| 3 | Medium | Numeric format and coercion | `artifacts/parts-id/app/admin-map-calibration.tsx:76-79,398-429,467-475,837-869` | Map calibration accepts a numeric prefix such as `12abc` and saves it as coordinate 12. | #1930 — Prevent mistyped calibration values from shifting the map |

## Findings

### Finding 1 — Malformed CSV quoting can silently alter imported inventory

- **File and line:** `artifacts/api-server/src/routes/adminUpload.ts:55-79,98-120`
- **Persistence boundary:** `POST /admin/upload` parses at `:377-407`, then upserts parsed rows in a transaction at `:414-432`. The same parser is used by the preview and order-upload paths.
- **Category:** CSV structure and quote handling
- **Severity:** Medium
- **Affected platforms:** Parts ID admin CSV import, including preview and final upload.
- **Classification:** Confirmed application defect.
- **Failure scenario:** An administrator imports an existing part with a description field whose opening quote has no closing quote, for example `ACME,BR-120,"Replacement breaker`. `parseCsvLine` reaches the end while still inside quotes but returns the field anyway; `parseCsv` accepts the row because Vendor and Catalog are present. The final upload can then replace the existing non-empty description with the truncated text.
- **Evidence:** `parseCsvLine` tracks `inQuotes` but never rejects an unterminated field (`:55-79`). `parseCsv` only treats a missing header/required columns or invalid OP/OQ as malformed (`:98-120`). The upload route checks only whether `parseCsv` returned `null` or an empty row set before entering the upsert transaction (`:399-432`). This establishes the accepted truncated row and persistence path by source inspection.
- **Safeguards and tests:** The transaction protects against mid-loop database failures, but does not protect against a syntactically malformed row that the parser accepts. `artifacts/api-server/__tests__/adminUpload.parseCsv.test.ts:48-82,229-258` covers missing headers, blank rows, quoted commas, and ordinary multi-row data; it does not cover unterminated quotes or quoted newlines. No live database import or destructive probe was run.
- **Recommended fix:** Use a CSV parser or strict state machine that rejects unterminated/structurally invalid quotes and returns a clear validation error before preview or persistence can accept partial rows. Explicitly support quoted newlines or reject them rather than splitting them into partial records.
- **Follow-up task:** **#1931 — Stop malformed CSV files from silently changing inventory** (proposed).

### Finding 2 — Part dimension text can be saved as a different measurement

- **Files and lines:** `artifacts/parts-id/components/AddPartForm.tsx:28-31,174-187,349-387`; `artifacts/parts-id/components/PartDetailsEditor.tsx:74-76,733-762,1639-1672`; `artifacts/parts-id/app/edit-item.tsx:66-69,560-563,645-661,1472-1505`
- **Persistence boundary:** Add Part sends parsed dimensions to `PATCH /inventory/:id/dimensions` after creating the part. Both edit screens send the same parsed values to that endpoint. The API validates the resulting values as finite numbers from 0 through 100,000 mm at `artifacts/api-server/src/routes/inventory.ts:3952-3995`, then merges them into the stored dimensions.
- **Category:** Numeric format and coercion
- **Severity:** Medium
- **Affected platforms:** Parts ID Add Part and both Edit Part experiences on mobile/web.
- **Classification:** Confirmed application defect.
- **Failure scenario:** The dimension controls remove every character except digits and periods, which removes a pasted minus sign (`-12.5` becomes `12.5`) but permits repeated periods (`1..2`). The shared parser then uses `parseFloat`, so `1..2` becomes `1` and is rounded and sent as a valid measurement. The server sees an ordinary non-negative number and persists it; the user receives no validation error explaining that their entry changed. In Add Part, a malformed period-only entry can also be truthy for `hasDims` and is converted to `null`.
- **Evidence:** The three clients contain the same permissive `parseFloat` pattern; Add Part’s dimension controls apply the lossy character filter and submit parsed fields. Both edit screens use the parsed values in the PATCH body. The API accepts `null` as a valid clear value and validates only the resulting JSON values, so it cannot recover the original text. Existing `artifacts/api-server/__tests__/inventoryEdit.integration.test.ts` coverage confirms the numeric API boundary and merge behavior, while `artifacts/parts-id/__tests__/addPartForm.test.tsx` and `artifacts/parts-id/__tests__/editSaveE2E.test.ts` cover normal form/save paths but do not establish rejection of negative paste or malformed decimal text.
- **Safeguards and tests:** The API rejects negative numbers and values above 100,000 mm when they arrive as numbers, but the clients can transform malformed text into an in-range number or `null` before the request. No runtime probe or test-data mutation was performed.
- **Recommended fix:** Preserve the original field text until validation; accept only complete finite non-negative decimal strings within the supported range, show a field-level error for malformed nonblank entries, and block add/save rather than stripping signs or accepting a numeric prefix. Keep intentionally blank fields’ current clear semantics.
- **Follow-up task:** **#1929 — Prevent part measurement typos from saving the wrong value** (proposed).

### Finding 3 — Map calibration accepts and saves numeric prefixes

- **File and line:** `artifacts/parts-id/app/admin-map-calibration.tsx:76-79,398-429,467-475,837-869`
- **Persistence boundary:** `PUT /admin/map-anchors/:slot`; `artifacts/api-server/src/routes/mapAnchors.ts:35-44,60-85`.
- **Category:** Numeric format and coercion
- **Severity:** Medium
- **Affected platforms:** Parts ID admin Anchor Calibration screen on mobile/web.
- **Classification:** Confirmed application defect.
- **Failure scenario:** An administrator pastes or enters `12abc` in Zone X or Zone Y. `safeParseFloat` returns 12, the slot-readiness check treats it as valid, and the per-slot save sends the numeric value 12. The API correctly requires finite JSON numbers, but receives only the already-coerced 12 and persists it as an anchor coordinate. That can shift the calibrated zone overlay without indicating the entered value was malformed.
- **Evidence:** `safeParseFloat` calls `parseFloat` and checks only finiteness (`:76-79`). The per-slot save uses its result directly in the upsert payload (`:398-429`), and slot readiness uses the same parser (`:467-475`). The coordinate TextInputs accept raw strings (`:837-869`). The server validates only that the received coordinates are finite numbers (`mapAnchors.ts:35-44`) before upserting them (`:68-85`), so it cannot reject a malformed original string after client coercion.
- **Safeguards and tests:** The UI prevents empty/non-finite values from becoming ready and guards duplicate saves/confirm taps. `artifacts/parts-id/__tests__/adminMapCalibrationWorkflow.test.tsx` covers ordinary numeric anchor saves, but no inspected test checks partial numeric strings or verifies that malformed values cause no write. Existing task #822 added helper text for tap-to-fill; it does not validate coordinate syntax. Existing task #1110 strictly validates floor-plan tile URL segments, a separate route and input contract, so it does not cover this form defect.
- **Recommended fix:** Require a complete finite numeric string before marking a slot ready or sending either per-slot or review/confirm writes. Keep valid decimals and supported signed world coordinates; show a field-level validation message for malformed nonblank input.
- **Follow-up task:** **#1930 — Prevent mistyped calibration values from shifting the map** (proposed).

## Unverified candidates and previously covered behavior

These observations were not counted as findings:

1. **Unassigned bin mismatch:** Add Part requires a nonblank bin in `AddPartForm.tsx:88-95`, while `POST /inventory/add-part` accepts an empty bin and stores an empty bin list (`artifacts/api-server/src/routes/inventory.ts:1601-1608,1632`). The form explicitly presents the bin as required, and no product rule was found establishing that an unassigned part must be manually addable; this is recorded as an intent question, not a confirmed defect.
2. **Search query-string numeric fallback:** The normal Search form submits a validated JSON body to `POST /inventory/search`. The server also has a legacy query-string fallback using numeric conversion (`inventory.ts:700-724`), but no normal form path was found that sends malformed dimensions through that fallback. No finding is claimed for the fallback.
3. **Login email normalization:** Login/sign-up checks trimmed emptiness but sends the original email string to Clerk. Clerk's normalization behavior was not independently established here, so this was not counted.
4. **CSV newline support:** The parser demonstrably splits physical lines before quote parsing. Whether product users rely on multiline description cells was not established, so this behavior is not counted as a separate verified finding. The follow-up should explicitly support or reject such records.

The edit/save tasks reviewed do not fully cover Finding 2's malformed-dimension parsing. Task #1036 (Add OP/OQ Inventory Controls) validates OP/OQ spreadsheet values and integer editor controls, not physical-dimension string parsing. Task #1101 (Audit Search Edit Save Display Journey) covers the save/display journey, not rejecting malformed measurement text. Tasks #822 and #1110 do not cover malformed map-calibration form input. No open task found in the searched task results fully covers any of the three findings. No dependencies are needed among the proposed fixes.

## Scope and audited form-path inventory

| Form or user-input path | Client path and input | API/input boundary and persistence | Audit result |
|---|---|---|---|
| Add Part | `components/AddPartForm.tsx` — vendor, catalog, bin, four dimensions, photos | `POST /inventory/add-part`; `PATCH /inventory/:id/dimensions`; photo route in `inventory.ts` | Dimension parsing finding 2; bin-required intent noted above. |
| Edit Part / Part Details Editor | `app/edit-item.tsx`; `components/PartDetailsEditor.tsx` — description, size, bins, barcodes, keywords, OP/OQ, dimensions, photos | Authenticated inventory PATCH routes in `inventory.ts` | Dimension parsing finding 2; other inspected fields have API checks or explicit client validation; no other verified finding. |
| Search and filters | `app/(tabs)/index.tsx`; `components/FilterPanel.tsx` — text, confidence, numeric ranges, category/chips | `POST /inventory/search`; body validation at `inventory.ts:648-724` | No confirmed malformed-input defect through the normal form path. |
| CSV and order import | `app/(tabs)/upload.tsx` — file/pasted CSV and replacement search | `/admin/upload/preview`, `/admin/upload`, `/admin/upload/orders/preview`, `/admin/upload/orders` in `adminUpload.ts` | CSV structure finding 1; order values have explicit integer validation. |
| Contact/support | `components/ContactSheet.tsx` | `POST /contact` | Existing merged task #1192 fully covers the prior contact submission/validation journey; no new finding. |
| Map calibration and zones | `app/admin-map-calibration.tsx`; zone editor controls | `PUT /admin/map-anchors/:slot`; warehouse-zone routes | Map coordinate parsing finding 3; no other confirmed zone-form issue. |
| Photo identification and hints | `app/(tabs)/photo.tsx` — photo and optional keyword/vendor/color/size/marking hints | Identify/search API client mutations | Inspected as part of input inventory; no confirmed finding. |
| Floor-plan and catalog uploads | Upload screen and `components/CatalogPdfUpload.tsx` — selected file, upload metadata, pages/chunks | Floor-plan and catalog-PDF upload/session endpoints | Inspected at the form-to-endpoint level; no forms/input-validation finding established. |
| Reference and Help questions | `components/ReferenceModal.tsx`; `app/(tabs)/help.tsx` | `/reference/ask`; `/help/ask` | No confirmed input-validation finding. |
| Authentication | `app/login.tsx`; `app/sign-up.tsx` — email/password/code | Clerk password and email-code operations | Clerk owns validation behavior; email normalization remains unverified. |
| Admin SQL console | `app/(tabs)/upload.tsx` | `POST /admin/query` | Boundary inventoried, but SQL security validation is explicitly outside this task's scope. |
| Search settings | `app/(tabs)/index.tsx` — confidence threshold and filter settings | Local persistence | No API persistence boundary; no confirmed finding. |

## Read-only tooling signals

- **Baseline:** `docs/validation/failure-baseline.json` had no active pre-existing failure records at audit start.
- **Dependency audit:** `pnpm audit --json` exited nonzero and reported **2 high-severity dependency advisories** (0 critical, 0 moderate, 0 low). This is a workspace dependency signal, not a verified Parts ID form defect; no dependency was changed.
- **Typecheck, lint, focused test suites:** Not run as separate commands. The assigned completion validation is restricted to `test-fast`; no API integration suite or live database probe was launched for this report-only audit.
- **Completion validation:** `pnpm run test-fast` passed (validation run `apQigkxR08ssFIyC30I89`, exit code 0). The completion callback also launched broader tiers despite the plan's explicit do-not-escalate rule: `test-standard` timed out in `codegen:check` at its 420-second execution budget; `test-standard-plus` and `test-heavy` both failed at `spec-check-tests` on the same unrelated `lib/api-spec/src/__tests__/ensure-codegen.test.ts` stale-owner test (expected exit 0, received 1). These out-of-scope checks were not rerun or repaired.
- **Mutation boundary:** No application code, tests, runtime data, credentials, or configuration were changed. No production database was queried or mutated.

## Limitations

- The canonical Bug Audit skill and its ten-category taxonomy were unavailable. The category labels above describe the verified input failure modes and are not represented as canonical skill labels.
- Verification used source contracts, existing test coverage, and task-plan review. No live API or database probes were run.
- File-picker internals, external Clerk behavior, and product policy for unassigned bins were not independently verified.
- The audit does not assess security, broad error handling, performance, or unrelated Canvas behavior.