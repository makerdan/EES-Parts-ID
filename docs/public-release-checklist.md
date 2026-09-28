# Public release checklist

Complete this checklist for a new public launch or after any history rewrite.
The checkboxes are evidence requirements, not permission to waive a failed
check.

## Repository and history

- [x] `git status --short` is clean and `git ls-files` contains no user upload,
      database export/backup, private object, operational log, or real secret.
- [x] Run `node scripts/test/public-repository-boundary.test.mjs`; its synthetic
      public-source/layout fixtures pass and its secret, export, upload, and
      user-data controls fail closed.
- [ ] The reachable-history scan reports no private paths across both public
      branch heads and provider-retained pull-request refs. CI fetches
      `refs/pull/*/head` explicitly so a normal checkout cannot silently omit
      provider-retained history. The branch-head rewrite is complete, but
      GitHub still retains rejected historical paths under read-only
      `refs/pull/*`; provider removal is required before this repository can
      make a complete public-history claim.
- [ ] The history scan proves the checkout is complete (not shallow, partial, or
      replace-ref based), includes provider-retained pull-request refs and the
      workflow's required ref and commit (`BOUNDARY_REQUIRED_REF` and
      `BOUNDARY_REQUIRED_COMMIT`), and scans every bounded reachable text blob
      — including ordinary source filenames — for credential and private-data
      classes before making a release claim. Diagnostics contain categories and
      ref class only, never matched values or raw historical paths.
- [ ] Review every new `data/public/` geometry/label change as intentionally
      public and confirm it uses the approved directory, CSV schema, columns,
      and value types with no database IDs, timestamps, inventory, user, or
      operational data.

**2026-09-18 evidence:** A fresh non-shallow clone of the public GitHub
repository contained nine public heads and no tags. The branch-head scan
reported zero historical private-path categories across 7,497 reachable blobs.
At rewrite time, six changed heads were replaced atomically with exact leases
and two clean heads remained unchanged; a later clean automation head accounts
for the ninth head. Protected-branch administrator enforcement, required
validation, force-push blocking, and deletion blocking were restored and
re-read after the rewrite.

A mirror fetch also discovered GitHub-retained `refs/pull/*` objects containing
100 distinct rejected historical paths. GitHub does not permit normal clients
to delete or force-update these refs. Full public-history release therefore
remains blocked until GitHub removes the retained pull-request refs, or the
owner approves replacing the repository. Diagnostics intentionally omit raw
historical paths and matched values.

## Runtime boundaries

- [ ] Confirm production values remain in Replit Secrets and Replit-managed
      PostgreSQL/Object Storage; no `.env` file, database export, upload, or
      log is tracked.
- [ ] Run the Clerk authorization route-boundary coverage, including
      `routeAuthorizationMatrix.integration.test.ts`: anonymous access is
      limited to health and minimized warehouse-layout reads, while inventory,
      admin, private-object, and write routes remain protected.
- [ ] Run `privateObjectAccess.integration.test.ts`: anonymous and pending
      users cannot read private uploads, approved users receive private
      no-store responses, and storage paths are not exposed.
- [ ] Run `publicWarehouseLayout.integration.test.ts`: anonymous metadata, SVG,
      tiles, zones, anchors, and alignment work with public cache semantics,
      while adjacent inventory/admin/private/write routes remain protected.

## GitHub protections

- [x] Review [the dated protection-status evidence](validation/github-protection-status.md).
      Do not treat `owner-action-required` or `unverified` as enabled.
- [x] Secret scanning, push protection, and dependency alerts are enabled by
      the repository owner and re-verified through GitHub after the repository
      is public.
- [ ] Pull requests, the stable required validation context, conversation
      resolution, administrator enforcement, and force-push/deletion blocks are
      verified for the protected default branch.
- [ ] Re-run this checklist after any change to repository visibility,
      branch rules, Actions policy, or the required validation workflow.

## Synchronization helper states

The local helper does not push to GitHub. A direct invocation with no arguments
or `--sync` is an intentional policy refusal and must exit with status `2`;
`POLICY_REFUSAL` is not synchronization evidence. Use the protected snapshot
pull-request process instead.

Read-only verification is the only successful helper state. After the approved
snapshot or review ref is available locally, provide the exact immutable
workspace revision and the approved commit ID (object ID) recorded by the
review process:

```bash
approved_commit="$(git rev-parse --verify refs/heads/snapshot/<approved-name>^{commit})"
release_id="<release-id>"
release_record="docs/validation/release-records/${release_id}.json"
bash scripts/sync-github.sh --locked-verify \
  --approved-ref refs/heads/snapshot/<approved-name> \
  --approved-commit "$approved_commit" \
  --release-id "$release_id" \
  --release-record "$release_record"
```

Use `--locked-verify` for the release-facing command. It acquires the
`public-release` repository coordination lock before capturing `HEAD`, creates
the release-record directory under that lock, and keeps verification and the
final evidence output under the same lock. Do not switch branches, update
`HEAD`, rebase, rewrite the checkout, or move the approved ref concurrently.
If lock acquisition fails, the command exits nonzero with an explicit
`serial-lock` diagnostic and does not invoke verification or produce a
`VERIFIED_SYNCHRONIZATION` record.

The helper derives the expected tree from the workspace commit, requires the
approved ref to resolve to the supplied approved commit, and checks the
workspace revision and approved-ref commit again before reporting success. A
workspace revision or approved-ref change during verification therefore
returns status `3` with `VERIFICATION_FAILURE`; it cannot produce evidence for
a different revision or approval. Status `0` with
`VERIFIED_SYNCHRONIZATION` proves that the captured workspace revision's tree
matches the approved ref at the supplied immutable approved commit, and that
no push was performed. On that successful state the helper creates the
requested JSON release record with the release ID, approved ref, approved
commit ID, workspace revision, and `VERIFIED_SYNCHRONIZATION` status together.
Its keys are `release_id`, `approved_ref`, `approved_commit_id`,
`workspace_revision`, and `verification_status`. Record creation is exclusive
and the file is made read-only; a later verification cannot overwrite the
evidence for that release. Missing, unsupported, invalid, stale,
changed-during-verification, and mismatched revision, ref, approved commit, or
release-record inputs return status `3`. Any other invocation error is a usage
failure; none of these states authorizes a direct push or a protected-branch
bypass.

## Incident response for an accidental commit

1. Stop the release or merge and avoid copying the value into issues, logs, or
   chat.
2. Rotate or revoke the credential with Clerk, Replit, the AI provider,
   PostgreSQL, Object Storage, or the relevant service.
3. Quarantine the private file and identify every reachable ref, fork, clone,
   cache, and artifact that may contain it.
4. Purge approved Git history and verify the rewritten refs with a fresh
   tracked-tree and history scan.
5. Record the incident privately, then publish only a sanitized summary and
   remediation guidance.

Boundary diagnostics report only bounded counts, safe current-tree locations,
and coarse categories. They never print matched secret values or raw private
historical paths.
