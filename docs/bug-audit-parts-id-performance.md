# Parts ID Performance Audit

**Scope:** Parts ID mobile/web client, its API server, and directly supporting inventory/search, map-tile, offline-cache, and catalog-PDF code.
**Mode:** Report-only; no application fixes made.
**Date:** 2026-09-27
**Stack:** Expo / React Native and React web; TypeScript; Node.js API server; PostgreSQL with Drizzle; Fuse.js; Poppler/pdfjs PDF processing.
**Coverage:** Performance only. Security and correctness were inspected only where needed to verify performance behavior.

## Summary

Nine source-traced performance issues were verified. No production load tests or representative large-catalog benchmarks were run, so the findings describe traced work and realistic scale scenarios rather than measured user-facing timings. All findings are severity-sorted.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 9 |
| Low | 0 |

| ID | Severity | Category | File:Line | Description | Follow-up |
|---|---|---|---|---|---|
| PID-PERF-001 | Medium | Performance — query CPU/memory | `artifacts/api-server/src/routes/inventory.ts:1374-1405` | Low-hit searches materialize the full inventory and build/run an in-memory Fuse index. | #1933 — Keep inventory browsing and search fast as stock grows |
| PID-PERF-002 | Medium | Performance — query CPU/memory | `artifacts/api-server/src/routes/inventory.ts:1493-1523` | Series variant discovery loads and scans the entire inventory for matching searches. | #1933 — Keep inventory browsing and search fast as stock grows |
| PID-PERF-003 | Medium | Performance — database work | `artifacts/api-server/src/routes/inventory.ts:545-548,595-600` | Deep inventory pages have no maximum offset and can make PostgreSQL walk and discard a large ordered prefix. | #1933 — Keep inventory browsing and search fast as stock grows |
| PID-PERF-004 | Medium | Performance — database work | `artifacts/api-server/src/routes/inventory.ts:595-601`; `artifacts/parts-id/utils/searchHelpers.ts:226-240` | Every page request runs an exact count; a full sync repeats that count sequentially for each 500-row page. | #1933 — Keep inventory browsing and search fast as stock grows |
| PID-PERF-005 | Medium | Performance — client memory/storage | `artifacts/parts-id/app/(tabs)/index.tsx:532-575,601-611`; `artifacts/parts-id/utils/offlineBarcode.ts:25-29,150-160` | Client sync collects and indexes all inventory rows; native full-cache writes bypass the incremental 5,000-item cap. | #1932 — Protect mobile Parts ID from stale work and oversized offline caches |
| PID-PERF-006 | Medium | Performance — redundant network work | `artifacts/parts-id/app/(tabs)/index.tsx:925-960` | The 8-second search timeout changes the UI and starts offline fallback but does not abort the pending request. | #1932 — Protect mobile Parts ID from stale work and oversized offline caches |
| PID-PERF-007 | Medium | Performance — redundant network work | `artifacts/parts-id/utils/tilePyramidCache.ts:37-60,72-90`; `artifacts/parts-id/components/WarehouseMapView.tsx:2050-2058,2096-2099` | Map prefetch abort stops queuing new tiles but cannot cancel downloads already started. | #1932 — Protect mobile Parts ID from stale work and oversized offline caches |
| PID-PERF-008 | Medium | Performance — upload memory | `artifacts/parts-id/utils/splitPdfIntoChunks.ts:55-85`; `artifacts/parts-id/components/CatalogPdfUpload.tsx:1348-1371,955-986,1015-1068` | The legacy upload fallback splits the whole PDF into chunks and retains all chunk byte arrays for retries. | #1934 — Prevent large catalog PDFs from exhausting memory |
| PID-PERF-009 | Medium | Performance — server memory | `artifacts/api-server/src/routes/catalogPdfUpload.ts:392-397,450-465`; `artifacts/api-server/src/routes/catalogPdf.ts:649-670`; `artifacts/api-server/src/utils/pdfProcessor.ts:211-259,270-315,347-380` | PDF queue closures retain whole buffers without a byte bound, while extraction retains page-scaled image and structure data. | #1934 — Prevent large catalog PDFs from exhausting memory |

## Findings

### PID-PERF-001 — Low-hit search fallback builds a full-catalog Fuse index per request

- **File and line:** `artifacts/api-server/src/routes/inventory.ts:1374-1405`
- **Category:** Performance — query CPU/memory
- **Severity:** Medium
- **Applicability and scale:** API, for mobile and web searches whose database-scored result set contains fewer than five entries. Cost grows with inventory rows and searchable text.
- **Evidence:** When `scoreMap.size < 5`, the handler runs an unpaginated `db.select().from(inventoryTable)`, builds a new Fuse index over the returned inventory, then executes a combined query and up to eight term searches. The full result set and index are allocated for each qualifying request. This is source-traced; no large-catalog timing was measured.
- **Risk scenario:** A warehouse with a large catalog receives a valid but uncommon or misspelled query. Several users can trigger overlapping full-table reads and synchronous fuzzy searches, increasing API CPU, heap use, and search latency.
- **Recommended fix:** Preserve fuzzy fallback behavior while using a bounded candidate set or a reusable/indexed search strategy. Add a large-fixture test or bounded local probe that verifies per-request rows and search work stay limited.
- **Follow-up task:** #1933 — Keep inventory browsing and search fast as stock grows.

### PID-PERF-002 — Series variant lookup scans the full catalog

- **File and line:** `artifacts/api-server/src/routes/inventory.ts:1493-1523`
- **Category:** Performance — query CPU/memory
- **Severity:** Medium
- **Applicability and scale:** API inventory searches that produce at least one result recognized as part of a catalog series. Cost grows with total inventory size, not just the result count.
- **Evidence:** When `seriesGroups.size > 0`, the handler selects every inventory row, then calls `getSeriesBase` on each item to find variants related to the current results. This repeats per request and is distinct from the low-hit Fuse fallback.
- **Risk scenario:** A common part query matches a series in a large catalog. The API loads and inspects unrelated rows before returning a small set of variants, increasing database transfer, API memory, and latency.
- **Recommended fix:** Resolve candidate variants through a selective database query or maintained series index, and retain tests for current variant grouping and ranking.
- **Follow-up task:** #1933 — Keep inventory browsing and search fast as stock grows.

### PID-PERF-003 — Inventory pagination permits unbounded deep offsets

- **File and line:** `artifacts/api-server/src/routes/inventory.ts:545-548,595-600`
- **Category:** Performance — database work
- **Severity:** Medium
- **Applicability and scale:** Authenticated API clients requesting deep pages on large inventories.
- **Evidence:** `limit` is capped at 500, but `page` has only a lower bound. The handler calculates `(page - 1) * limit` and sends it as a SQL offset ordered by vendor and catalog. There is no maximum page or offset.
- **Risk scenario:** A client asks for a deep page in a growing catalog. PostgreSQL may need to walk and discard a large ordered prefix to return a small page; repeated deep requests waste database work.
- **Recommended fix:** Introduce cursor/keyset pagination or a documented maximum offset with a clear response. Keep ordinary inventory browsing and sync behavior intact.
- **Follow-up task:** #1933 — Keep inventory browsing and search fast as stock grows.

### PID-PERF-004 — Full inventory sync repeats an exact count for every page

- **File and line:** `artifacts/api-server/src/routes/inventory.ts:595-601`; `artifacts/parts-id/utils/searchHelpers.ts:226-240`
- **Category:** Performance — database work
- **Severity:** Medium
- **Applicability and scale:** Full inventory syncs and any client that walks the paginated endpoint. The cost rises with both row count and page count.
- **Evidence:** Each `GET /inventory` call runs the requested page query and a separate exact `count(*)` query. `fetchInventoryPages` requests 500 rows at a time and awaits each page before requesting the next, so the same full qualifying count is repeated sequentially for each page.
- **Risk scenario:** A catalog with many pages needs one exact count scan per page during sync. This increases database work and stretches total sync time even though only one count is needed to report initial progress.
- **Recommended fix:** Avoid repeating the exact count on every page where the client can safely reuse a count or where the endpoint can return pagination metadata more efficiently. Verify behavior when inventory changes during a sync.
- **Follow-up task:** #1933 — Keep inventory browsing and search fast as stock grows.

### PID-PERF-005 — Full sync has no effective offline inventory size bound

- **File and line:** `artifacts/parts-id/app/(tabs)/index.tsx:532-575,601-611`; `artifacts/parts-id/utils/searchHelpers.ts:226-240`; `artifacts/parts-id/utils/offlineBarcode.ts:25-29,150-160`
- **Category:** Performance — client memory/storage
- **Severity:** Medium
- **Applicability and scale:** Native and web clients during full sync; persistent offline-cache storage applies to native. Memory and serialized data grow with all inventory rows and their descriptions/keywords.
- **Evidence:** The page helper appends all results into one `allItems` array. The screen then builds the Fuse index over that array. Native full sync serializes and writes the complete array through `replaceBarcodeCacheWithServerItems`. Although incremental cache upserts stop at 5,000 items, the full-replacement function applies no such cap. The web intentionally skips the disk write but still fetches and indexes the full array in memory.
- **Risk scenario:** A warehouse grows beyond the catalog size that a worker device can comfortably fetch, index, and serialize. Sync can take a long time or increase memory/storage pressure; the incremental 5,000-item cap does not protect this full-sync path.
- **Recommended fix:** Establish and test a supported offline catalog envelope, then use bounded/incremental indexing and storage or provide a clear offline-capacity outcome without silently claiming the full catalog is cached.
- **Follow-up task:** #1932 — Protect mobile Parts ID from stale work and oversized offline caches.

### PID-PERF-006 — Search timeout does not cancel the pending request

- **File and line:** `artifacts/parts-id/app/(tabs)/index.tsx:925-960`
- **Category:** Performance — redundant network work
- **Severity:** Medium
- **Applicability and scale:** Web and native searches that exceed the 8-second timeout.
- **Evidence:** `submitSearch` calls `mutateSearch`, then starts an 8-second timer. On timeout it marks the generation, resets visible search state, and starts offline fallback. It does not pass a cancellation signal or cancel the mutation. The request can continue through its transport and server handler after the user is shown fallback results.
- **Risk scenario:** A slow request completes after the user has moved on or after fallback has started. It consumes network/API work without serving the timed-out interaction, particularly during a search slowdown.
- **Recommended fix:** Associate an abort controller with each search generation, abort it on timeout or replacement, and keep the existing stale-result guard for transports that cannot be cancelled.
- **Follow-up task:** #1932 — Protect mobile Parts ID from stale work and oversized offline caches.

### PID-PERF-007 — Map prefetch abort cannot stop already-started downloads

- **File and line:** `artifacts/parts-id/utils/tilePyramidCache.ts:37-60,72-90`; `artifacts/parts-id/components/WarehouseMapView.tsx:2050-2058,2096-2099`
- **Category:** Performance — redundant network work
- **Severity:** Medium
- **Applicability and scale:** Native map only; web returns before tile prefetch. Triggered by a user changing zoom/gesture while a prefetch is active.
- **Evidence:** The caller aborts the current `AbortController`, and `prefetchZoomLevel` checks its signal only while queuing tiles. It starts every tile in the computed range concurrently, calls `fetchTile` without the signal, and `fetchTile` uses `FileSystem.downloadAsync` without a cancellation handle. `Promise.all` waits for the already-started fetches.
- **Risk scenario:** A fast sequence of zoom changes leaves downloads for obsolete zoom ranges consuming network and storage work until they finish. The next gesture can start another prefetch.
- **Recommended fix:** Make the actual download cancellable where supported, and/or use a small bounded worker pool with in-flight tile deduplication so obsolete ranges cannot fan out.
- **Follow-up task:** #1932 — Protect mobile Parts ID from stale work and oversized offline caches.

### PID-PERF-008 — Legacy PDF upload fallback retains every split chunk

- **File and line:** `artifacts/parts-id/components/CatalogPdfUpload.tsx:1348-1371,955-986,1015-1068`; `artifacts/parts-id/utils/splitPdfIntoChunks.ts:55-85`
- **Category:** Performance — upload memory
- **Severity:** Medium
- **Applicability and scale:** Web and native clients when durable-upload session discovery fails and the API is temporarily unavailable or on an older rolling deployment; large PDFs above the chunk threshold.
- **Evidence:** The durable-upload fallback calls `handleChunkedUpload` for large PDFs. `splitPdfIntoChunks` constructs and returns every page chunk as a `Uint8Array`; the component stores the complete array in `chunksRef` so any later server-side failure can retry a chunk. The input bytes are also live while splitting; the normal per-chunk size does not limit total document bytes or chunk count.
- **Risk scenario:** An admin selects a large, multi-hundred-page PDF while the durable endpoint is unavailable. The client can retain the source plus all serialized page chunks and keep the chunks for retries, raising peak memory on a mobile device.
- **Recommended fix:** Bound total PDF bytes/pages, generate and upload chunks incrementally, and retain only the minimum data needed for a recoverable retry. Preserve the durable upload path and recovery behavior.
- **Follow-up task:** #1934 — Prevent large catalog PDFs from exhausting memory.

### PID-PERF-009 — Catalog PDF job backlog and extraction memory scale with PDF bytes/pages

- **File and line:** `artifacts/api-server/src/routes/catalogPdfUpload.ts:392-397,450-465`; `artifacts/api-server/src/routes/catalogPdf.ts:649-670`; `artifacts/api-server/src/utils/pdfProcessor.ts:211-259,270-315,347-380`
- **Category:** Performance — server memory
- **Severity:** Medium
- **Applicability and scale:** API process under several concurrent admin PDF uploads, especially large or high-page-count documents. The standard client splits PDFs into 20-page chunks; server-side extraction does not enforce a page-count limit.
- **Evidence:** Durable upload completion assembles/passes the full PDF as a `Buffer` to `launchCatalogPdfBuffer`. The function limits active jobs (default three), but over-limit jobs each schedule a one-second retry closure that retains their full `pdfBuffer`; there is no queued-byte/job cap in this path. Once active, the Poppler path renders every page and reads all PNGs into an array of `PageData`; rich-text extraction concurrently requests structure trees for all pages. Thus active concurrency does not bound the memory held by waiting buffers or by page-scaled extraction.
- **Risk scenario:** Several completed sessions wait behind active work, or an accepted document contains many pages. Retained full-file buffers and page image/structure data can accumulate, raising API memory and delaying other processing. No production load or memory measurement was performed.
- **Recommended fix:** Bound the queue by both job count and bytes, avoid retaining complete buffers in retry-timer closures, enforce page/resource limits, and process rendered pages/structure trees in bounded batches with cleanup.
- **Existing-task check:** #158 (“AI Abuse Controls”) addresses excessive PDF job concurrency, while current code already limits active jobs by default; it does not bound the durable queue's retained bytes or per-document extraction memory. #991 (“Make catalog PDF uploads durable”) addresses bounded upload-part staging and durability, not extraction memory. #1914 (“Prevent new chunks from starting after a catalog job is cancelled”) addresses terminal-state checks, not resource bounds. None directly covers this finding.
- **Follow-up task:** #1934 — Prevent large catalog PDFs from exhausting memory.

## Follow-up tasks

Every verified finding maps to a proposed task. No existing task was counted as coverage unless its scope directly addressed the unresolved issue.

| Finding IDs | Task (proposed status) | Coverage |
|---|---|---|
| PID-PERF-005, PID-PERF-006, PID-PERF-007 | **#1932 — Protect mobile Parts ID from stale work and oversized offline caches** | Bounds offline cache/sync resource use and addresses stale search and map-prefetch work. |
| PID-PERF-001, PID-PERF-002, PID-PERF-003, PID-PERF-004 | **#1933 — Keep inventory browsing and search fast as stock grows** | Covers full-table fallback/variant scans, deep offsets, and repeated per-page counts. |
| PID-PERF-008, PID-PERF-009 | **#1934 — Prevent large catalog PDFs from exhausting memory** | Bounds client chunk retention, server queue bytes, and per-document extraction memory. |

All three task records are **PROPOSED** and implementation has not started. #1932 and #1934 were proposed for this audit. #1933 was already listed as a proposed task in the starting project snapshot; its current task record and done criteria were checked and directly cover the four API findings. Task refs and titles are verified from returned task records. No canonical clickable URL format was available to verify for this document, so refs are shown unambiguously as `#ref — title` rather than fabricated links. The candidate fix tasks are ready for the user to select.

## Tooling signals

- **Typecheck:** Direct Parts ID and API-server TypeScript checks passed with no reported errors.
- **Lint:** Parts ID lint passed with one warning at `artifacts/parts-id/app/(tabs)/index.tsx:1190` (unnecessary `isCurrentSearch` dependency); API-server lint passed cleanly.
- **Tests:** The assigned `pnpm run test-fast` completion check passed. The completion callback also launched higher tiers despite the fast-only plan: `test-standard` timed out in `static-validation-boundaries` at its 420-second budget; `test-standard-plus` and `test-heavy` failed on the same `ensure-codegen.test.ts` stale-owner lock assertion (expected exit 0, received 1), with generated-output inventory mismatches also reported. These extra tiers were not retried because the plan explicitly forbids escalation. Only this report file changed; no application, test, configuration, or generated-output files were modified.
- **Dependency audit:** `pnpm audit --audit-level=low` reported two High advisories for `image-size@2.0.2`. A project patch exists and no production import in the audited Parts ID paths was found. This is recorded as a tooling/security signal, not as a verified performance finding; no dependency was changed.
- **Other read-only checks:** Reviewed client request/cache flows, inventory SQL construction, catalog-PDF concurrency and extraction paths, and existing targeted tests. No local large-data benchmark or production load test was run.

## Reviewed surfaces with no additional verified issue

- **React rendering and result lists:** The search results use a memoized/virtualized list. The inspected render/effect paths and `searchResultMemoStability` test did not establish a separate excessive-render or list-memory defect.
- **Search-result cache:** The query-result cache has an explicit 100-entry LRU cap. This does not bound the separate full offline inventory cache described in PID-PERF-005.
- **Map geometry:** The tile pyramid is clamped to a maximum 16×16 grid. No unbounded tile-coordinate range was found; PID-PERF-007 concerns cancellation of already-started downloads, not unbounded tile geometry.
- **Inventory search response size:** Existing result limiting and request throttling reduce response and request volume. They do not prevent the verified full-table scans in PID-PERF-001 and PID-PERF-002.
- **PDF job concurrency:** Active processing has a default concurrency limit of three. PID-PERF-009 is specifically the lack of a byte-bounded waiting queue and page-bounded extraction, not a claim that active jobs are unlimited.

## Unverified candidates and areas not audited

- **Reference inventory-context substring search:** The route appears to apply substring matching to serialized inventory context, but no representative query plan or bounded local measurement was collected. It is not reported as a verified defect.
- **PDF page limits under ordinary use:** The normal uploader splits documents into 20-page chunks. The performance impact of larger direct/legacy submissions was not measured; PID-PERF-009 is a traced lack of a server page/resource bound, not a measured outage.
- **Production behavior:** No live production load test, production data query, deployment operation, or runtime-data mutation was performed.
- **Out of scope:** Canvas, unrelated validation infrastructure, broad correctness/security auditing, and non-PDF upload flows were not audited for general performance.