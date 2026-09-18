# Public repository readiness

**Assessment date:** 2026-09-18
**Scope:** every public GitHub head plus provider-retained pull-request refs
**Current-tree status:** boundary guard passes. **Repository visibility status:**
the owner-approved branch-head rewrite is complete, but full public-history
readiness remains blocked by rejected paths retained in GitHub pull-request
refs.

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

- Tracked user-upload directories, including spreadsheets, PDFs, screenshots,
  pasted diagnostics, and uploaded images/text.
- Operational/export archives.
- A database-shaped zone backup. Its geometry was retained in
  `data/public/warehouse-zones.csv` after removing database IDs and timestamps.
- The importer’s dependency on a committed spreadsheet; imports now require an
  explicitly supplied external path.
- A real Clerk administrator user identifier from `.replit`.

Raw database backups are not an acceptable public distribution format. Public
layout data must remain source-oriented and reviewable.

## Reachable-history rewrite evidence

On 2026-09-18, the owner-approved rewrite removed 100 distinct rejected paths
from the public branch-head graph. Six changed heads were replaced in one
atomic, force-with-lease transaction; the other two public heads already had
clean, independent histories and remained unchanged.

A fresh clone after publication verified all nine current public heads and no
tags. The ninth head is a later clean automation branch.
The checkout was non-shallow and non-partial, no replace refs were active, and
the boundary scanner reported zero historical private-path categories while
scanning 7,497 reachable blobs. All clean branch tip trees remained
byte-identical through the rewrite.

That normal clone does not fetch GitHub's read-only `refs/pull/*` namespace. A
mirror fetch found that provider-retained pull-request refs still expose the
same 100 rejected historical paths. Normal Git and GitHub API clients cannot
delete or force-update these refs. The repository cannot claim a complete
public-history purge until GitHub removes those retained refs, or the owner
approves replacing the repository.

The remaining protected-content matches are documented synthetic placeholder
or test values; no verified live credential was found. Existing clones, forks,
caches, and downloaded artifacts remain separate distribution boundaries and
must not be treated as rewritten automatically. Do not paste credentials or
private historical paths into issues, commits, or chat.

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
`VERIFIED_SYNCHRONIZATION` only when one supplied immutable commit revision's
tree matches both the selected repository's `HEAD` before and after the
verification and an approved `review/` or `snapshot/` ref (including an
approved pull-request head). The release wrapper must coordinate workspace
changes so that revision remains checked out for the complete call; a branch
switch, rebase, or other `HEAD` change during verification returns status `3`
with `VERIFICATION_FAILURE` rather than producing evidence for another
revision. Missing, stale, unsupported, or mismatched refs also return status
`3`. See the [public release checklist](public-release-checklist.md) for the
command and the required interpretation of each state.

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

- [ ] Complete the provider-side removal of retained pull-request refs, then
      verify branch heads and `refs/pull/*` with a fresh mirror scan.
- [ ] Run a provider secret scanner over every rewritten ref and rotate any
      live credential it reports.
- [ ] Confirm warehouse geometry and public labels are safe to disclose.
- [ ] Confirm no new inventory, user, analytics, audit, message, catalog, or
      object-storage exports were added outside the tracked-tree guard.
