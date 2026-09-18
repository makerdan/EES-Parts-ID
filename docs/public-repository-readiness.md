# Public repository readiness

**Assessment date:** 2026-09-18
**Scope:** every public GitHub head and its reachable history in a fresh,
non-shallow clone
**Current-tree status:** boundary guard passes. **Repository visibility status:**
the owner-approved history rewrite is complete, and the fresh public-GitHub
scan reports no reachable private-path categories.

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
from the complete public GitHub ref graph. Six changed heads were replaced in
one atomic, force-with-lease transaction; the other two public heads already
had clean, independent histories and remained unchanged.

A fresh clone after publication verified all eight public heads and no tags.
The checkout was non-shallow and non-partial, no replace refs were active, and
the boundary scanner reported zero historical private-path categories while
scanning 7,490 reachable blobs. All clean branch tip trees remained
byte-identical through the rewrite.

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
`VERIFIED_SYNCHRONIZATION` only when the expected Git tree matches both the
selected repository's current `HEAD^{tree}` and an approved `review/` or
`snapshot/` ref (including an approved pull-request head). Re-read the current
tree after any workspace change; a valid older tree is stale input and cannot
produce verification evidence. Missing, stale, unsupported, or mismatched refs
return status `3` with `VERIFICATION_FAILURE`. See the [public release
checklist](public-release-checklist.md) for the command and the required
interpretation of each state.

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

- [x] Complete and verify the reachable-history purge for the findings above.
- [ ] Run a provider secret scanner over every rewritten ref and rotate any
      live credential it reports.
- [ ] Confirm warehouse geometry and public labels are safe to disclose.
- [ ] Confirm no new inventory, user, analytics, audit, message, catalog, or
      object-storage exports were added outside the tracked-tree guard.
