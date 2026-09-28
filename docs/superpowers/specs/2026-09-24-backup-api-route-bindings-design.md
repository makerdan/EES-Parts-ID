# Restore backup API route bindings

## Problem
The admin snapshot route no longer typechecks because three established request or service bindings were replaced with undefined names. The dry-run handler cannot select the requested snapshot or create a bounded confirmation expiry, and the status handler incorrectly attempts to start a backup instead of reading status.

## Design
Restore the last known-good expressions at the three damaged sites:

- Select the dry-run snapshot with `req.body?.snapshotId`.
- Set its confirmation expiry to `Date.now() + CONFIRMATION_TTL_MS`.
- Read status with `getManualInventoryBackupStatus()`.

Do not alter the backup lease, persistence, restore, or response contracts. Add route-level regression coverage proving dry-run uses the request snapshot and emits a future expiry, while status reads state without starting a backup.

## Alternatives
- Declare local variables with the missing names: rejected because this would preserve the incorrect status-side effect and obscure the request binding.
- Refactor the complete snapshot router: rejected because the regression is three isolated substitutions and broader changes would increase risk around backup and restore behavior.

## Regression check
Run the API-server typecheck and focused route integration tests, then run the fast validation tier. The focused route tests must fail if status starts a backup or dry-run stops using the request snapshot and bounded expiry.