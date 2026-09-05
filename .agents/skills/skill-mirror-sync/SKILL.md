---
name: skill-mirror-sync
description: >-
  Add, audit, project, invoke, validate, verify, or repair account-managed
  skills and their disposable runtime mirrors. Use when source selection,
  projection freshness, metadata, interrupted refreshes, locks, or mirror
  parity are uncertain.
---

# Skill Mirror Sync

Use this skill when adding, auditing, invoking, validating, repairing, or
investigating an account-managed skill projection or runtime mirror. Keep the
boundary one-way and fail closed: the account source is authoritative, the
workspace projection is generated, and the runtime mirror is disposable.

## Authority and boundaries

- `ACCOUNT_SKILLS_SOURCE` is the required, explicit, authoritative
  account/platform source. Treat its account-wide `.account-revision` as opaque;
  it must be present and non-empty. Never invent, infer, or silently substitute
  a fallback source.
- The generated workspace projection belongs only under
  `.agents/skills/.account-projections/`. Workspace-authored skills elsewhere
  under `.agents/skills/` must not be overwritten or removed.
- `.local/custom_skills/<skill-id>/` is a platform-owned runtime mirror. It is
  downstream and disposable. Never edit it directly, promote it back, or use
  its body, timestamps, or metadata to claim that the account source is current.
- The direction is account source → generated projection → runtime mirror.
  A runtime mirror never flows back into either upstream stage, and repository
  automation must not simulate platform provisioning by writing its sidecar.
- Do not copy private account instructions, credentials, secrets, or a
  reconstructed registry into tracked repository files, and never fabricate
  source paths, revisions, fingerprints, manifests, sidecar metadata, or
  success results.

## Source and fingerprint contract

Before loading a skill, validate the source and projection:

1. Resolve only `ACCOUNT_SKILLS_SOURCE`; if it is unset, unreadable, not a
   directory, or has an empty `.account-revision`, stop with an unavailable or
   blocked result. Do not load an older projection.
2. Discover deterministic immediate source directories. Each skill directory
   must have a valid lowercase slug and `SKILL.md`. Recursively enumerate every
   regular supporting file, sort paths deterministically, and reject symlinks,
   special files, and unexpected source entries.
3. The projection manifest records its format, source revision, sorted file
   lists, and each skill fingerprint. The authoritative fingerprint is
   SHA-256 over each relative path and its bytes in sorted order, with stable
   separators. Compare the opaque revision and fingerprint exactly; do not
   derive either from timestamps. MD5 is not an authoritative fingerprint.
4. Reject a missing or malformed manifest, missing or extra files, a revision
   mismatch, a fingerprint mismatch, or any source change detected during the
   copy. These are incomplete or stale projections, never a reason to load
   old instructions.

## Safe refresh and loading

Project every currently published account skill with the only supported
repository mutation command:

```sh
ACCOUNT_SKILLS_SOURCE=/platform/account-skills pnpm account-skills:sync
```

The source variable is required. The command reports only a bounded JSON
outcome, whether the generated projection changed, and the projected skill
count. It does not print source paths or skill contents. If the source is
unavailable or malformed, the command fails without treating an older
projection as current. Do not add another sync command or workflow around the
helper.

The command invokes the all-skills projection helper once. Refresh follows this
contract:

1. Acquire its serialized, ownership-aware lock before inspecting or changing
   the projection. If a lock is live or cannot be safely inspected, report
   busy and do not remove active work.
2. Recover an abandoned lock only when its structured owner is provably dead,
   or an unstructured lock is provably stale under the helper's timeout.
   Recovery must be atomic and race-safe.
3. Under the lock, remove only helper-owned staging and backup directories
   whose names have the expected format and valid identifier. Never delete a
   similarly named or active directory.
4. Build the complete projection in a new staging directory. Validate its
   recursive manifest and all bytes before installation, then re-read the
   source revision. If the source changed, discard staging and retry or report
   the change; do not install a mixed snapshot.
5. Install with guarded directory renames: move an existing projection to an
   owned backup, rename staging into place, and restore the backup if the
   install fails. Clean staging and backup artifacts in a `finally` path.
   Never replace the destination by an unguarded delete-and-copy operation.
6. Validate the installed projection again immediately before loading. If the
   requested skill is absent or validation fails, fail closed. Return only
   supported content from the validated projection.

Invocation-time loading uses the same helper before selecting one projected
skill, so it validates and refreshes the complete account projection rather than
copying one skill independently.

An interrupted refresh is handled by the same ownership-safe cleanup on the
next supported refresh. Do not manually rescue partial files, merge staging
contents, or load a prior projection while the source is unavailable.

## Read-only runtime-mirror status

Use the supported non-mutating command:

```sh
pnpm account-skill:status -- --skill <skill-id>
```

It reads the account source and the platform-owned
`.local/custom_skills/<skill-id>/.account-skill-metadata.json` sidecar. The
sidecar's format, skill ID, source revision, and fingerprint must exactly match
the canonical account metadata. Interpret outcomes as:

- `pass` (exit 0): identity, revision, and fingerprint match;
- `mismatch` (exit 1): mirror metadata is invalid or differs;
- `unavailable-source` (exit 2): canonical source or revision cannot be read;
- `missing-mirror` (exit 3): the platform mirror sidecar is absent.

Status is distinct from all-skills projection and invocation-time loading. It is
read-only and must not write the mirror, sidecar, projection, or source just to
make a check pass. Do not print skill contents, source paths, secrets,
credentials, mirror values, or private account instructions. Missing
authoritative metadata is unknown/unavailable, not a pass. If the platform does
not expose authoritative mirror metadata, parity is unknown.

## Failure ownership and reporting

Classify before remediating:

| Observation | Owner | Repository action |
|---|---|---|
| Account content, revision, or publication is wrong | Account/platform skill owner | Report identity and bounded result; do not patch a mirror |
| Mirror is missing or stale after supported refresh | Account/platform provisioning or sync owner | Report environment, identity, and opaque metadata; request platform remediation |
| Canonical source or validation metadata is unavailable | Account/platform owner | Report unavailable and preserve fail-closed loading |
| Lock is live, unreadable, or not provably abandoned | Repository maintainer | Report busy or blocked; never remove active ownership or bypass serialization |
| Projection implementation, boundary, or focused contract is wrong | Repository maintainer | Fix the repository contract or implementation |

Reports should contain the skill ID, environment, validation surface, bounded
outcome, and opaque revision or SHA-256 fingerprint when available. Include a
timestamp only if the reporting system requires it. Never fabricate a source
path, revision, fingerprint, manifest, sidecar metadata, or success result.
Hand-editing `.local/custom_skills` is never remediation.

## Prohibited shortcuts

- Do not edit `.local/custom_skills`, reverse-promote its files, or make a
  runtime mirror authoritative.
- Do not endorse a direct canonical-to-runtime copy as a substitute for the
  account-source and generated-projection stages.
- Do not use MD5, timestamps, file-body comparison alone, or a made-up
  fallback source as authoritative validation.
- Do not expose or persist private account-level skill contents.
- Do not bypass the lock, atomic rename/rollback, source-change check, recursive
  validation, or fail-closed behavior to make invocation succeed.
