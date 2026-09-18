# Public repository readiness

**Assessment date:** 2026-09-04
**Scope:** current tracked tree and reachable Git history
**Current-tree status:** boundary guard passes. **Repository visibility status:**
the repository is public, but release readiness remains blocked because private
historical objects remain reachable from Git history.

## Intentionally public

- Application, API, database-schema, migration, and test source code.
- Electrical terminology dictionaries and synthetic test fixtures.
- Warehouse floor-plan SVG assets and source-oriented layout data under
  `data/public/`.
- The public layout CSV contains geometry, inventory-display flags, and stable
  public aisle/section labels. It does not contain database row IDs or
  timestamps.

Warehouse layout data is public by classification. That classification does
not extend to inventory contents, user records, analytics, audit logs, support
messages, catalog uploads, or object-storage payloads.

## Removed from the current tree

- The tracked `attached_assets/` directory, including spreadsheets, PDFs,
  screenshots, pasted diagnostics, and uploaded images/text.
- `exports/react-render-audit.zip`, an operational/export archive.
- `warehouse_zones_backup_2026-07-05.csv`, a database-shaped zone backup. Its
  geometry was retained in `data/public/warehouse-zones.csv` after removing
  database IDs and timestamps.
- The importer’s dependency on a committed spreadsheet; imports now require an
  explicitly supplied external path.
- A real Clerk administrator user identifier from `.replit`.

Raw database backups are not an acceptable public distribution format. Public
layout data must remain source-oriented and reviewable.

## Reachable-history findings

The 2026-09-04 history scan found 100 private paths that are no longer in the
current tree:

- Historical `attached_assets/...` paths, including uploaded reports,
  catalog documents, screenshots, and diagnostic logs.
- A historical `inventory_export.csv` containing inventory rows and bin
  locations.
- Historical warehouse-zone backup and export archive paths.

These objects remain recoverable from reachable commits. Before changing
repository visibility, the repository owner must perform an approved
history-rewrite/purge procedure and verify the result with a fresh
full-history scan. Existing clones, forks, caches, and downloaded artifacts
must be considered separately.

The credential-shaped history matches reviewed during this assessment were
documented placeholders or fake test values; no verified live credential was
found in the current tree. If the owner’s full secret scan finds any live
credential in history, rotate it before or while purging the history. Do not
paste credentials into issues, commits, or chat.

## Ongoing boundary check

Run:

```bash
node scripts/test/public-repository-boundary.test.mjs
```

The same check is part of `test-fast`. It rejects tracked upload/storage
directories, database/export archives, database-shaped inventory/zone
backups, non-migration SQL dumps, obvious credential formats, non-synthetic
email addresses, and user identifiers in fixture/seed paths. It also requires a
non-shallow, non-partial checkout before scanning reachable blob contents,
applies the same content checks to tracked generated bundles, and validates the
approved public layout CSV schema and value types. Any historical findings are
reported for owner remediation rather than silently treated as purged; raw
historical paths and matched values are never printed.


## GitHub synchronization boundary

`scripts/sync-github.sh` fails closed. Its default invocation and explicit
`--sync` request return status `2` with `POLICY_REFUSAL`; they do not claim that
the public repository matches the workspace. The helper never pushes directly
to the protected default branch.

The helper's read-only `--verify` mode returns status `0` with
`VERIFIED_SYNCHRONIZATION` only when an exact expected Git tree matches an
approved `review/` or `snapshot/` ref (including an approved pull-request
head). Missing, stale, unsupported, or mismatched refs return status `3` with
`VERIFICATION_FAILURE`. See the [public release checklist](public-release-checklist.md)
for the command and the required interpretation of each state.

## Release documents

- [Security policy](../SECURITY.md) — responsible disclosure, supported
  versions, secret handling, and the Clerk/Replit boundary.
- [Public data classification](public-data-classification.md) — what may be
  tracked and where runtime-private data belongs.
- [Public release checklist](public-release-checklist.md) — required repository,
  history, runtime, authorization, upload, map, and GitHub evidence.
- [GitHub protection status](validation/github-protection-status.md) — dated
  read-only evidence that distinguishes verified controls from owner action.

## Owner checklist before release

- [ ] Complete and verify the reachable-history purge for the findings above.
- [ ] Run a provider secret scanner over every rewritten ref and rotate any
      live credential it reports.
- [ ] Confirm warehouse geometry and public labels are safe to disclose.
- [ ] Confirm no new inventory, user, analytics, audit, message, catalog, or
      object-storage exports were added outside the tracked-tree guard.
