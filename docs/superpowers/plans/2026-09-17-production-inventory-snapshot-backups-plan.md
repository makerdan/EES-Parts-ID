# Implementation Plan: Production Inventory Snapshot Backups

## Source Spec
- Spec file: `docs/superpowers/specs/2026-09-17-production-inventory-snapshot-backups-design.md`
- Approved by user: 2026-09-17

## Pre-plan checklist
- [x] The approved source specification exists and contains no TODO, TBD, or placeholder sections.
- [x] The work is one implementable unit: production inventory snapshot creation, retention, protection, and recovery.
- [x] External services, packages, environment variables, schema changes, generated API contracts, and deployment requirements are inventoried below.
- [x] Tasks are ordered so each dependency is implemented before its consumers.
- [x] Regression hardening explicitly reproduces the empty-inventory incident and proves recovery remains possible.

## Dependencies
- Existing Replit-managed production PostgreSQL database and Publish-managed development-to-production schema workflow.
- Existing private Replit App Storage bucket and server-side configuration through `DEFAULT_OBJECT_STORAGE_BUCKET_ID` and `PRIVATE_OBJECT_DIR`.
- Existing `@google-cloud/storage` dependency and Replit sidecar authentication in the API server.
- Node.js built-in streaming, `zlib`, and `crypto` APIs; no new compression or checksum package is required.
- Existing approved-admin authorization middleware, route authorization matrix, and admin audit logging.
- Existing OpenAPI source in `lib/api-spec/openapi.yaml`, Orval code generation, `@workspace/api-zod`, and `@workspace/api-client-react`.
- A new Publish-managed schema addition for snapshot operational metadata. Development receives the migration through the normal post-merge path; production receives it only through Publish.
- A new scheduled worker artifact configured for a daily UTC Scheduled Deployment. The user must choose or confirm the daily cron time in the Publishing interface because schedule activation is a deployment setting.
- The worker must receive production database and private App Storage bindings from Replit; it must not introduce a second database credential or run schema synchronization.

## Tasks

### T001: Define versioned snapshot and operational metadata contracts
- **Blocked by**: []
- **Files**: `lib/db/src/schema/inventory_snapshot.ts`, `lib/db/src/schema/index.ts`, `lib/db/drizzle/NNNN_inventory_snapshot.sql`, `lib/api-spec/openapi.yaml`, `artifacts/api-server/src/lib/inventorySnapshotTypes.ts`
- **Details**: Define the versioned JSON Lines row contract and manifest contract from the approved design, including snapshot ID, UTC creation time, reason, source environment, row count, data checksum, object generation/checksum, ordered exported fields, schema fingerprint, object path, verification status, predecessor, last-known-good eligibility, and optional build identifier. Add a small operational metadata table for run status, health, anomaly state, and audit correlation; do not store inventory copies in PostgreSQL. Ensure recovery can reconstruct truth from verified App Storage manifests if the metadata table is empty or unavailable. Hand-write the Drizzle SQL migration according to the repository convention and keep production migration exclusively in the Publish flow. Add API schemas for snapshot summaries, dry-run results, restore confirmation, and health without exposing storage paths or inventory contents.
- **Done when**: Schema/type checks accept the new contracts; the migration adds only operational metadata and indexes; a snapshot remains independently verifiable from its data object and manifest; API schemas expose no bucket path, credential, or raw inventory payload.

### T002: Implement immutable private snapshot storage and verification
- **Blocked by**: [T001]
- **Files**: `artifacts/api-server/src/lib/objectStorage.ts`, `artifacts/api-server/src/lib/inventorySnapshotStorage.ts`, `artifacts/api-server/src/__tests__/inventorySnapshotStorage.test.ts`
- **Details**: Add a dedicated private inventory-backup namespace beneath `PRIVATE_OBJECT_DIR`. Enforce canonical prefix validation and reject path traversal or cross-namespace object references. Implement unique immutable data-object uploads using generation-match preconditions, read-back metadata verification, manifest-last commit semantics, manifest listing, and verified snapshot download. Treat a data object without a valid manifest as incomplete and non-restorable. Use streaming gzip and SHA-256 so large inventories do not require duplicate uncompressed buffers in memory. Do not expose signed or public snapshot URLs.
- **Done when**: The storage adapter can write, list, read, and verify an immutable snapshot pair; duplicate object creation and unsafe paths fail closed; partial uploads never appear in the valid snapshot list; focused storage tests pass.

### T003: Build the consistent snapshot service and empty-table protection
- **Blocked by**: [T001, T002]
- **Files**: `artifacts/api-server/src/lib/inventorySnapshot.ts`, `artifacts/api-server/src/lib/inventorySnapshotLock.ts`, `artifacts/api-server/src/__tests__/inventorySnapshot.test.ts`
- **Details**: Implement stable inventory export in ascending ID order within a repeatable read-only transaction. Acquire a transaction-scoped PostgreSQL advisory lock before snapshot, retention, or restore work so competing operations cannot overlap. Serialize every supported inventory field deterministically, compute the schema fingerprint and content checksum during streaming, verify the uploaded object, then commit the manifest and operational run metadata. Compare the current count with verified history: when zero follows a non-empty last-known-good snapshot, create an `incident-empty` snapshot, retain the prior non-empty last-known-good pointer, mark health critical, and emit structured high-severity metadata without inventory contents. Permit an empty baseline only through an explicit audited approved-admin action.
- **Done when**: Identical consistent reads produce identical content checksums; overlapping operations cannot both enter the protected section; upload or verification failures leave prior valid state unchanged; an unexpected empty export cannot replace a non-empty last-known-good snapshot.

### T004: Add retention and backup health evaluation
- **Blocked by**: [T003]
- **Files**: `artifacts/api-server/src/lib/inventorySnapshotRetention.ts`, `artifacts/api-server/src/lib/inventorySnapshotHealth.ts`, `artifacts/api-server/src/__tests__/inventorySnapshotRetention.test.ts`, `artifacts/api-server/src/__tests__/inventorySnapshotHealth.test.ts`
- **Details**: Implement UTC retention selection that keeps the newest 90 valid daily snapshots and one verified monthly snapshot for each of the newest 12 calendar months. Always protect the newest valid snapshot and current last-known-good snapshot. Verify protected monthly snapshots before deleting expired daily objects. Keep a newly verified snapshot valid when retention cleanup fails, but report retention degradation separately. Compute server-side health for snapshot age, last-known-good age and count, latest run outcome, consecutive failures, empty anomaly, and retention status.
- **Done when**: Deterministic retention fixtures preserve exactly the required recovery points and protected exceptions; incomplete objects are ignored; cleanup failures do not invalidate valid snapshots; health classifications distinguish stale, failed, anomalous, and healthy states.

### T005: Require verified snapshots before risky inventory operations
- **Blocked by**: [T003]
- **Files**: `artifacts/api-server/src/routes/adminUpload.ts`, `artifacts/api-server/src/routes/inventory.ts`, `artifacts/api-server/src/lib/inventoryMutationGuard.ts`, `artifacts/api-server/__tests__/adminUpload.integration.test.ts`, `artifacts/api-server/__tests__/inventorySnapshotGuard.integration.test.ts`
- **Details**: Add one mutation guard that acquires the shared operation lock and creates a verified pre-operation snapshot before bulk import, bulk replacement, inventory-wide or multi-row deletion, and future explicitly classified destructive operations. Integrate it with the existing transactional admin upload path and qualifying inventory bulk routes without changing single-row edit/add behavior. Keep the lock on the same database connection and across the snapshot-to-mutation boundary so no competing restore or protected mutation can interleave. If snapshot creation, verification, or manifest commit fails, return an explicit service-unavailable/conflict response and perform no inventory mutation.
- **Done when**: Every qualifying existing bulk mutation is routed through the guard; failure and lock-contention tests prove zero rows are changed; successful operations have a verified `pre-import` or `pre-delete` snapshot; single-row operations remain unchanged.

### T006: Implement approved-admin listing, dry-run, restore, and baseline approval
- **Blocked by**: [T003, T004, T005]
- **Files**: `artifacts/api-server/src/routes/adminSnapshots.ts`, `artifacts/api-server/src/routes/index.ts`, `artifacts/api-server/src/routes/routeAccessMatrix.ts`, `artifacts/api-server/src/lib/inventorySnapshotRestore.ts`, `artifacts/api-server/__tests__/adminSnapshots.integration.test.ts`, `lib/api-spec/openapi.yaml`
- **Details**: Add approved-admin-only endpoints for snapshot summaries, health, dry-run comparison, confirmed replacement restore, and explicit empty-baseline approval. Require a fresh restore confirmation tied to the selected snapshot ID, manifest checksum, and dry-run result so stale confirmations are rejected. Reverify manifest/data/schema before restore; acquire the exclusive operation lock; create and verify a `pre-restore` snapshot; replace inventory in one transaction; reset sequences or derived state as needed; validate final count/content expectations; invalidate inventory-dependent caches; and write audit records for all attempts and outcomes. Never accept arbitrary object paths from callers and never return them. Update the authorization matrix so static validation catches an unguarded route.
- **Done when**: Unauthorized and non-approved callers are rejected; dry runs make no writes and report insert/update/remove/preserve/reject counts plus newer-record warnings; failed restores roll back completely; successful restores match the chosen snapshot and produce a pre-restore snapshot and audit record.

### T007: Generate and validate the administrative API contract
- **Blocked by**: [T001, T006]
- **Files**: `lib/api-spec/openapi.yaml`, `lib/api-zod/src/generated/**`, `lib/api-client-react/src/generated/**`, `lib/api-spec/src/__tests__/check-route-drift.test.ts`
- **Details**: Finalize OpenAPI operations and response schemas for the administrative backup surface, regenerate Zod and client outputs through the canonical codegen command, normalize generated barrels using existing repository tooling, and extend route-drift coverage. Keep generated inventory fields synchronized, including `totalOpOq`, so this work does not preserve the stale declaration baseline.
- **Done when**: Code generation completes without stale fallback; route/spec drift checks cover every new endpoint; generated source and declaration outputs are synchronized and importable; `codegen:check` exits 0.

### T008: Add the production-only scheduled backup worker
- **Blocked by**: [T003, T004]
- **Files**: `artifacts/inventory-backup-worker/package.json`, `artifacts/inventory-backup-worker/tsconfig.json`, `artifacts/inventory-backup-worker/src/index.ts`, `artifacts/inventory-backup-worker/.replit-artifact/artifact.toml`, root workspace/type-reference configuration as required
- **Details**: Create a minimal one-shot worker that asserts `DATABASE_ENV=production`, confirms it is targeting the production database, invokes one scheduled snapshot plus retention cycle, logs structured metadata, closes resources, and exits non-zero on snapshot failure. It must never run Drizzle schema push, migrations, a web server, or an in-process timer. Register it as a separate artifact and configure its production service for Scheduled Deployment; document the required daily UTC cron selection in the artifact/deployment guidance without hardcoding credentials or a second database URL.
- **Done when**: The worker exits 0 only after a verified scheduled snapshot and completed or explicitly degraded retention result; it rejects development/test targets and missing private storage configuration; its production command is one-shot and contains no schema mutation; the artifact is registered and ready for the user to activate on a daily schedule.

### T009: Regression hardening — preserve a recoverable non-empty snapshot after total deletion
- **Blocked by**: [T003, T004, T005, T006]
- **Files**: `artifacts/api-server/__tests__/inventorySnapshotRecovery.integration.test.ts`, supporting test helpers under `artifacts/api-server/__tests__/helpers/`
- **Details**: Add the explicit incident reproduction required by the source specification. Seed a populated inventory, create and verify a non-empty snapshot, remove all current rows inside the isolated test fixture, run the scheduled path, and assert that the new snapshot is classified `incident-empty` without replacing the non-empty last-known-good snapshot. Dry-run and restore the earlier snapshot, then compare every exported inventory field and row count. Also assert that manifest/data corruption blocks restore, pre-restore snapshot failure blocks mutation, and a forced mid-restore database error rolls back atomically. Use an isolated fake storage adapter or unique private test namespace and delete only objects/rows owned by the current test.
- **Done when**: The test fails if an empty run can replace last-known-good, if corrupted/partial snapshots become restorable, or if restore is non-atomic; the full recovery scenario passes and leaves unrelated database/storage fixtures untouched.

### T010: Verify schema, security, worker, and repository validation
- **Blocked by**: [T002, T003, T004, T005, T006, T007, T008, T009]
- **Files**: No additional files except corrections required for failures caused by this implementation
- **Details**: Run focused snapshot/storage/retention/restore/guard tests first, then database schema checks, production-target checks, route authorization checks, codegen checks, worker and API typechecks/lints, and finally the registered `test-standard` tier. Confirm App Storage snapshots remain private, no production DDL path was added, generated artifacts are current, and the worker fails closed outside production. Classify failures against the baseline below; do not fix unrelated failures.
- **Done when**: All focused checks and every task-owned assertion pass; `test-standard` has no new failure beyond documented pre-existing failures; the worker and API compile and lint; the working tree contains no unintended generated or snapshot data.

## Pre-existing failures to ignore
These failures exist on `main` before this task starts. Do not investigate or fix them unless this task directly changes the failing behavior.

- **`inventoryEdit.integration.test.ts` — repeated-search freshness case**: the standard baseline returned HTTP 500 instead of 200 in “returns saved keywords from repeated search and a fresh app instance” while the tier ran under concurrent load.
- **Mockup `ZoneEditor` undo/redo timing budget**: “pushUndo is capped” took 15.47 seconds against a 10-second individual budget.
- **Parts ID standard-suite result accounting**: the baseline runner marked the Parts ID package failed although its timeout report showed no individual Parts ID budget violation or named failing test; treat this ambiguous pre-task result as pre-existing unless the new worker/API changes reproduce it consistently.

**Flaky-test rule:** If a test not listed above fails, retry it 3× in isolation before concluding it is a regression caused by this work. Only treat a consistent 3/3 failure as task-owned.

If the only remaining failures are those listed above, the executor is cleared to complete the task. Do not expand scope to repair them.

## Validation
**Command:** `test-standard`
**Why:** This tier covers API integration behavior, database contracts, route authorization, generated API consistency, TypeScript, lint, and the workspace packages affected by the new worker.
**Do not escalate:** Run exactly this command. Pre-existing failures are handled above and are never a reason to run a heavier tier.

## Regression Guard
**Covers:** A populated production inventory is deleted, a subsequent scheduled run sees zero rows, and the empty state must not replace the last-known-good non-empty recovery point.
**Test location:** `artifacts/api-server/__tests__/inventorySnapshotRecovery.integration.test.ts`
**What it checks:** The test creates a verified non-empty snapshot, deletes the fixture inventory, proves the next snapshot is classified `incident-empty` while the prior snapshot remains last-known-good, then atomically restores and verifies every exported row; it fails if empty-state propagation or a non-atomic restore can destroy recovery.

## Relevant files
- Approved design: `docs/superpowers/specs/2026-09-17-production-inventory-snapshot-backups-design.md`
- Inventory schema and migrations: `lib/db/src/schema/inventory.ts`, `lib/db/src/schema/index.ts`, `lib/db/drizzle/`
- Runtime database boundary: `lib/db/src/runtimeDataBoundary.ts`
- Private storage adapter: `artifacts/api-server/src/lib/objectStorage.ts`
- Inventory mutation routes: `artifacts/api-server/src/routes/inventory.ts`, `artifacts/api-server/src/routes/adminUpload.ts`
- Authorization and audit: `artifacts/api-server/src/middlewares/requireAdminAuth.ts`, `artifacts/api-server/src/routes/routeAccessMatrix.ts`, `lib/db/src/schema/admin_audit_log.ts`
- API contract and generation: `lib/api-spec/openapi.yaml`, `lib/api-zod/src/generated/`, `lib/api-client-react/src/generated/`
- Production configuration precedent: `artifacts/api-server/.replit-artifact/artifact.toml`