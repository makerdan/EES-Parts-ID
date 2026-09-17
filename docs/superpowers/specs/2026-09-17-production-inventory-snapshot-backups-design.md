# Production Inventory Snapshot Backups

## Purpose

Protect production inventory from accidental deletion, destructive imports, database resets, and operational mistakes by maintaining immutable recovery snapshots outside PostgreSQL.

The system protects the production `inventory` table only. It does not continuously mirror production into another database because continuous synchronization could immediately copy an accidental deletion into the backup.

## Goals

- Create one verified production inventory snapshot every day.
- Create and verify a snapshot before any bulk import, bulk replacement, inventory-wide deletion, or restore.
- Retain 90 daily snapshots and 12 monthly snapshots.
- Preserve a separately identified last-known-good snapshot.
- Detect an unexpected transition from populated inventory to an empty table.
- Provide an approved-admin restore workflow with a dry run and atomic execution.
- Keep snapshot data private and outside the database being protected.

## Non-goals

- Back up the entire production database.
- Back up the development database.
- Provide a continuously queryable database replica.
- Automatically restore data after detecting an anomaly.
- Replace Replit deployment or database checkpoint features.

## Selected approach

Use private Replit App Storage for timestamped, immutable, compressed inventory snapshots.

Each snapshot consists of:

1. A versioned JSON Lines data file compressed with gzip.
2. A JSON manifest written only after the data file has uploaded and passed verification.

A snapshot is valid only when both objects exist and their recorded checksum and row count match. The manifest is the commit marker; an uploaded data file without a valid manifest is incomplete and cannot be restored.

This approach is preferred over:

- **A second PostgreSQL database:** queryable, but more costly and operationally complex; synchronization can propagate deletions.
- **Backup tables in production PostgreSQL:** easy to implement, but vulnerable to the same database reset, credential error, or broad destructive operation.

## Components

### Snapshot service

A focused server module owns:

- Stable inventory serialization in ascending inventory ID order.
- Streaming gzip compression.
- Cryptographic content checksums.
- Schema fingerprint generation.
- Private object upload and post-upload verification.
- Snapshot manifest creation.
- Snapshot listing and validity checks.

The service accepts a snapshot reason such as `scheduled`, `pre-import`, `pre-delete`, `pre-restore`, or `incident-empty`.

### Scheduled backup worker

A dedicated scheduled production worker invokes the snapshot service daily. It must run against the production database and production App Storage configuration. It must not perform schema changes.

Only one backup, retention, or restore operation may run at a time. A database-backed advisory lock or equivalent durable lock prevents overlapping operations.

### Retention worker

After a successful daily snapshot, retention processing:

- Keeps the newest 90 valid daily snapshots.
- Promotes or preserves one valid snapshot per calendar month for 12 months.
- Never deletes the newest valid snapshot.
- Never deletes the current last-known-good snapshot.
- Ignores incomplete objects that lack a valid manifest and reports them for cleanup.
- Verifies protected monthly snapshots before removing expired daily snapshots.

All retention windows use UTC.

### Administrative recovery API

Approved-admin-only endpoints provide:

- A list of valid snapshots and manifest metadata.
- A dry-run comparison for a selected snapshot.
- An explicitly confirmed restore operation.
- Restore status and audit history.

Snapshot object paths are never exposed as public URLs. The API returns metadata and controlled comparison results, not storage credentials.

## Snapshot manifest

Each manifest includes:

- Manifest format version.
- Snapshot identifier.
- Creation time in UTC.
- Snapshot reason.
- Source environment, fixed to `production`.
- Inventory row count.
- Uncompressed content checksum.
- Compressed object checksum or generation identifier.
- Schema fingerprint and ordered exported field list.
- Data object path.
- Export completion and verification status.
- Previous valid snapshot identifier.
- Last-known-good eligibility.
- Application build or release identifier when available.

No manifest field contains database credentials, authentication tokens, or complete inventory records.

## Daily snapshot flow

1. Acquire the backup lock.
2. Open a read-only, repeatable database transaction or equivalent consistent read.
3. Read production inventory in stable ID order.
4. Compare the row count with the previous valid and last-known-good snapshots.
5. Stream the versioned JSON Lines export through gzip while calculating its checksum.
6. Upload the data object to a unique immutable path.
7. Verify object existence, size, checksum, and exported row count.
8. Write the manifest last.
9. Update last-known-good metadata only if safety rules allow it.
10. Apply retention rules.
11. Release the lock and record structured operational metadata.

The worker must fail explicitly if database reads, serialization, upload, verification, or manifest creation fail.

## Empty-table protection

An empty inventory snapshot is valid evidence of the current state but is not automatically trusted as the last-known-good recovery point.

If the current row count is zero and the previous last-known-good snapshot was non-empty:

- Create a snapshot with reason `incident-empty`.
- Do not replace or expire the non-empty last-known-good snapshot.
- Mark the run as anomalous.
- Emit a high-severity operational event.
- Do not automatically restore data.

An empty snapshot may become last-known-good only through an explicit approved-admin action that records the decision.

This rule ensures the original failure mode—an unexplained empty production inventory—cannot silently replace the usable backup.

## Pre-operation protection

The following operations must request and verify a snapshot before changing inventory:

- Spreadsheet or catalog bulk import.
- Upsert modes capable of replacing or zeroing many rows.
- Inventory-wide or multi-row deletion.
- Disaster recovery restore.
- Future maintenance operations classified as destructive or bulk-changing.

The operation must stop before mutation if:

- Snapshot creation fails.
- Upload verification fails.
- The manifest cannot be committed.
- Another backup or restore holds the lock.

Single-row edits and additions do not require synchronous pre-operation snapshots; they are covered by daily snapshots.

## Restore workflow

Restore is manual, approved-admin-only, and never triggered by the scheduled worker.

### Dry run

For a selected valid snapshot:

1. Verify the manifest and data checksum again.
2. Validate the snapshot format and schema compatibility.
3. Compare snapshot records with current production inventory.
4. Report records that would be inserted, updated, removed, preserved, or rejected.
5. Highlight records newer than the selected snapshot.
6. Perform no database mutation.

### Confirmed restore

The default disaster-recovery mode replaces production inventory with the selected snapshot:

1. Require a fresh explicit confirmation tied to the snapshot identifier and dry-run result.
2. Acquire the exclusive operation lock.
3. Create and verify a `pre-restore` snapshot of the current state.
4. Reverify the selected snapshot.
5. Restore inside one database transaction.
6. Roll back the transaction on any validation or write failure.
7. Verify final row count and expected record content.
8. Record the result in the administrative audit log.
9. Release the lock.

No automatic merge mode is included initially. Deterministic replacement is safer for disaster recovery; selective recovery can be added later if a concrete need emerges.

## Security and privacy

- Store snapshots only under a private App Storage prefix.
- Restrict snapshot creation and restore controls to server-side code.
- Require approved-admin authorization for listing, comparing, confirming, and restoring snapshots.
- Use short, structured operational logs containing IDs, counts, checksums, reasons, durations, and outcomes—not inventory contents.
- Record all restore attempts and explicit empty-baseline approvals in the existing admin audit system.
- Never accept a storage object path supplied without validating it against the managed backup prefix and manifest inventory.
- Prevent path traversal and cross-environment restore.

## Error handling

- Partial data uploads without manifests remain invalid and non-restorable.
- Manifest upload failure leaves the previous valid snapshot unchanged.
- Retention failure does not invalidate a newly verified snapshot.
- Lock contention causes a bounded retry or explicit failure; it does not start a concurrent operation.
- Schema incompatibility blocks restore and reports the incompatible fields.
- Restore verification failure rolls back the database transaction and preserves the pre-restore snapshot.
- Operational health reports distinguish snapshot failure, retention failure, anomaly detection, and restore failure.

## Monitoring

Expose server-side backup health metadata containing:

- Time and age of the latest valid daily snapshot.
- Time and age of the last-known-good non-empty snapshot.
- Latest row count.
- Latest run outcome and reason.
- Consecutive failure count.
- Empty-table anomaly status.
- Retention status.

Health is degraded when no valid daily snapshot exists within the expected window. It is critical when inventory is unexpectedly empty, when no valid non-empty recovery point exists, or when repeated snapshot creation fails.

## Validation

### Unit coverage

- Stable serialization produces deterministic checksums.
- Manifest validation rejects missing, altered, or incompatible data.
- Retention keeps 90 daily and 12 monthly recovery points.
- Retention never deletes the newest valid or last-known-good snapshot.
- Empty-table protection preserves the previous non-empty last-known-good snapshot.
- Backup object paths cannot escape the private managed prefix.

### Integration coverage

- A failed data upload never creates a valid manifest.
- A failed manifest upload leaves the previous valid snapshot usable.
- Risky bulk operations stop when snapshot verification fails.
- Dry runs do not mutate inventory.
- Confirmed restore is atomic and rolls back on failure.
- Restore creates a verified pre-restore snapshot first.
- Concurrent backup and restore attempts cannot overlap.

### Regression hardening

An end-to-end regression test must reproduce the incident this design addresses:

1. Seed a populated inventory.
2. Create and verify a non-empty snapshot.
3. Delete all current inventory rows.
4. Run the scheduled snapshot path.
5. Prove the empty state is recorded as an incident snapshot.
6. Prove the empty state does not replace the last-known-good snapshot.
7. Restore the prior snapshot.
8. Prove the original inventory content is recovered.

The backup feature is not complete unless this test passes.

## Success criteria

- Production inventory receives one verified snapshot per day.
- Bulk destructive operations cannot proceed without a verified pre-operation snapshot.
- Ninety daily and twelve monthly snapshots are retained without unbounded growth.
- An unexplained empty inventory cannot become the last-known-good state automatically.
- An approved administrator can preview and atomically restore a valid snapshot.
- A failed or partial backup cannot appear as restorable.
- Backup health exposes stale, failed, and anomalous states without exposing inventory data.