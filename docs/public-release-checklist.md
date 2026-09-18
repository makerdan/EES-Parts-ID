# Public release checklist

Complete this checklist for a new public launch or after any history rewrite.
The checkboxes are evidence requirements, not permission to waive a failed
check.

## Repository and history

- [ ] `git status --short` is clean and `git ls-files` contains no user upload,
      database export/backup, private object, operational log, or real secret.
- [ ] Run `node scripts/test/public-repository-boundary.test.mjs`; its synthetic
      public-source/layout fixtures pass and its secret, export, upload, and
      user-data controls fail closed.
- [ ] The reachable-history scan reports no private paths. If it reports any,
      stop and complete an owner-approved history purge before launch; do not
      claim that deleting the current-tree copy removed historical data.
- [ ] The history scan proves the checkout is complete (not shallow, partial, or
      replace-ref based) and scans every bounded reachable text blob for
      credential and private-data classes before making a release claim.
- [ ] Review every new `data/public/` geometry/label change as intentionally
      public and confirm it uses the approved directory, CSV schema, columns,
      and value types with no database IDs, timestamps, inventory, user, or
      operational data.

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
snapshot or review ref is available locally, provide the exact expected tree:

```bash
expected_tree="$(git rev-parse HEAD^{tree})"
bash scripts/sync-github.sh --verify \
  --expected-tree "$expected_tree" \
  --approved-ref refs/heads/snapshot/<approved-name>
```

Read `HEAD^{tree}` immediately before verification and re-read it after any
workspace change. The helper binds evidence to the selected repository's
current workspace tree, so a valid older tree is stale input even when it
still matches the approved ref. Status `0` with
`VERIFIED_SYNCHRONIZATION` proves that the current workspace tree matches the
approved ref's tree and that no push was performed. Missing refs, unsupported
approval refs, invalid trees, stale expected trees, and approved-ref tree
mismatches exit with status `3` and `VERIFICATION_FAILURE`. Any other
invocation error is a usage failure; none of these states authorizes a direct
push or a protected-branch bypass.

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
