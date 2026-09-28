# Manual Database Backup Design

## Purpose

Replace the proposed scheduled inventory backup workflow with an administrator-triggered backup in the Parts ID Admin tab. The backup must continue on the API server if the administrator backgrounds or closes the app.

## Scope

- Add a confirmation-first **Database Backup** control under **Admin → People & System**.
- Reuse the existing full inventory snapshot format, private App Storage destination, validation, and retention behavior.
- Run the backup asynchronously on the API server after returning an immediate accepted response.
- Show the current or latest manual backup status when the administrator is viewing the Admin screen.
- Close the unmerged scheduler pull request because the manual flow replaces it.

The backup does not need to survive an API server restart or deployment.

## Server Architecture

The existing protected inventory snapshot route will become an asynchronous manual-backup entry point.

When an approved administrator starts a backup, the server will:

1. Reject client-supplied database targets, storage paths, timing, or credentials by accepting no backup configuration in the request body.
2. Suppress duplicate work when another manual backup is already running.
3. Capture the initiating administrator identity for audit records.
4. Start the existing full inventory snapshot and retention operation in the API process.
5. Return `202 Accepted` immediately so the mobile request does not own the backup lifecycle.
6. Retain an in-process status record containing the phase, initiation time, completion time, row count, snapshot identifier, and safe failure message.

The server operation continues when the app backgrounds, navigates away, or closes. In-process status may be lost if the API server restarts; restart recovery is explicitly out of scope.

## API Contract

The OpenAPI contract will expose:

- A protected mutation that starts a manual inventory backup and returns the accepted/running state.
- A protected query that returns the current running operation or latest manual backup result.

Both routes require the existing approved-administrator middleware. Responses expose safe metadata only and never return private object paths, bucket identifiers, secrets, or database connection details.

Concurrent start requests do not create parallel snapshots. They return the already-running operation so repeated taps, retries, or multiple admin sessions remain idempotent while work is active.

## Snapshot Behavior

Each backup remains a full, self-contained inventory snapshot:

- Every inventory row and supported exported field is serialized.
- Data is compressed and written to private App Storage.
- The manifest contains its row count, checksum, schema fingerprint, source environment, anomaly status, and previous valid snapshot identifier.
- Existing retention rules prune snapshots after a successful write.
- Existing empty-inventory anomaly detection remains active.

The snapshot reason will identify the operation as a manual administrator backup rather than a scheduled backup.

## Admin Experience

The **Database Backup** card appears in **Admin → People & System** for approved administrators.

1. The administrator presses **Database Backup**.
2. A confirmation dialog explains that a full inventory snapshot will be created in private backup storage.
3. After confirmation, the button enters a disabled submitting state until the server accepts the job.
4. The screen shows **Backup in progress** and polls the status endpoint while visible.
5. The administrator may switch apps, navigate away, or close Parts ID without stopping the server operation.
6. Returning to the screen reloads the server status.
7. Completion shows the row count and full local date and time, for example: **Completed September 19, 2026 at 4:42 AM**.
8. Failure shows a safe error and enables retry.

Dates remain precise ISO timestamps in the API and snapshot manifest. Locale-aware date-and-time formatting is a presentation concern in the app.

The control includes an accessibility label, disabled/busy state, confirmation text, and a polite live-region announcement for accepted, completed, and failed states.

## Error Handling

- Authentication and authorization failures use the existing protected-route behavior.
- Missing production database or private storage configuration fails the background operation and records a safe failed state.
- Snapshot or retention failures are logged server-side without exposing sensitive paths or configuration.
- A failed backup never reports success and does not prevent a later retry.
- Duplicate requests during an active backup return the active operation instead of failing or starting another backup.

## Scheduler Pull Request

PR #10 remains unmerged. After the manual flow is implemented and validated, close the pull request because the scheduled workflow is no longer desired. Do not manually trigger the scheduled production workflow.

## Regression Hardening

Server tests will prove:

- Non-admin and unapproved users cannot start or inspect backup operations.
- The start route returns `202 Accepted` before the snapshot promise settles.
- The snapshot continues after the response lifecycle ends.
- Concurrent start requests share one active operation.
- Success records snapshot identifier, row count, and timestamps without private paths.
- Failure records a retryable safe state.
- The manual snapshot reason and existing retention operation are used.

Admin-screen tests will prove:

- The action requires confirmation.
- Cancelling confirmation starts nothing.
- Confirming sends one request and displays the accepted/running state.
- The control prevents repeated submission while active.
- Returning to the screen reloads current/latest status.
- Success includes a human-readable full date and time plus row count.
- Failure is announced and allows retry.

The task uses the validation tier selected by its implementation plan and must not merge the obsolete scheduler pull request.