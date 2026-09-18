# Skill Compression Review: Skill Mirror Sync

## Review status

- Target: canonical `.agents/skills/skill-mirror-sync/SKILL.md`
- Identity: lowercase `skill-mirror-sync`
- Scope: clean-room account-source, generated-projection, and disposable-runtime-mirror guidance
- Recommendation: **Apply**
- Source status: no authoritative prior canonical `SKILL.md`; the obsolete
  `.local/custom_skills/skill-mirror-sync/SKILL.md` was not used as B0.
- Immutable baseline: the approved design plus
  `docs/validation/account-level-skills.md`,
  `scripts/account-skill-status.mjs`,
  `scripts/lib/account-skill-projection.mjs`, and
  `scripts/test/skill-mirror-sync-contract.test.mjs`.

## Invariant ledger

| Area | Invariant retained |
|---|---|
| Triggers | Covers adding, auditing, invoking, validating, repairing, and investigating source, projection, metadata, mirror, lock, and refresh failures. |
| Authority | Explicit `ACCOUNT_SKILLS_SOURCE` and its non-empty opaque revision are authoritative; no fallback or timestamp revision. |
| Direction | Account source → generated `.agents/skills/.account-projections/` → disposable `.local/custom_skills/`; never reverse. |
| Source inputs | Immediate skill directories with `SKILL.md`; recursive regular files; sorted paths; symlinks and unexpected entries rejected. |
| Fingerprint | SHA-256 over sorted relative paths and bytes; MD5 is not authoritative. |
| Workflow order | Lock, ownership-safe cleanup, staging, recursive validation, source re-read, guarded rename/rollback, final validation, then load. |
| Recovery | Only provably abandoned locks and helper-owned stale staging/backup artifacts may be recovered. |
| Exceptions | Missing/unavailable source, stale or incomplete projection, source change, busy lock, missing skill, and mirror mismatch fail closed or produce bounded status. |
| Verification | `pnpm account-skill:status -- --skill <skill-id>` is read-only with pass, mismatch, unavailable-source, and missing-mirror outcomes. |
| Ownership | Account/platform owns content and provisioning; repository maintainer owns implementation, boundaries, and focused contracts. |
| Outputs | Report identity, environment, validation surface, bounded result, and opaque metadata without contents, secrets, or fabricated values. |
| Constraints | Do not edit runtime mirrors, copy private instructions, create registries, write sidecars during status, or change implementation behavior. |

## Brainstorm-and-iterate rounds

### Round 1 — coverage-first candidate

The first candidate grouped the contract into authority, recursive validation,
refresh safety, status, ownership, and reporting. It explicitly chose the
approved repository contracts as the baseline and rejected treating the
runtime mirror as source material. The invariant ledger was drafted before
compression so safety behavior could not disappear during editing.

### Round 2 — failure-path and boundary iteration

The second round walked unavailable sources, malformed metadata, revision drift,
source mutation during copying, concurrent refreshes, abandoned locks,
interrupted staging, failed rename, missing mirrors, and unknown platform
metadata. It added explicit ownership and prohibited-shortcut language so each
failure has a safe response rather than an implicit fallback.

Exactly two brainstorm-and-iterate rounds were performed.

## Ordered compression passes

### Pass 1 — remove redundancy

Merged repeated source-of-truth, no-fallback, and no-runtime-edit statements
into the authority section while retaining a separate prohibited-shortcuts
checklist for quick audits. Combined duplicate freshness and manifest rules
without removing recursive files, sorting, path/byte hashing, or fail-closed
requirements.

### Pass 2 — clarify decision boundaries

Separated projection validation from read-only mirror status. Distinguished
account publication failures, platform provisioning failures, and repository
implementation failures. Made ownership of lock cleanup explicit and limited
recovery to provably abandoned or helper-owned artifacts.

### Pass 3 — polish language and ordering

Reordered the candidate from authority → source contract → refresh workflow →
status → ownership → prohibited shortcuts. Replaced implementation-dependent
detail with portable behavioral instructions while retaining command names,
paths, outcomes, and ordering needed for execution.

Exactly three ordered passes were performed in the stated order.

## Adversarial checks

- **Reverse promotion:** rejected; the candidate states that runtime mirrors
  never flow upstream and must not be edited.
- **Fallback source:** rejected; missing `ACCOUNT_SKILLS_SOURCE` is unavailable
  and never falls back to repository or runtime files.
- **Weak fingerprint:** rejected; SHA-256 path-and-byte hashing is required and
  MD5, timestamps, and body-only comparison are explicitly non-authoritative.
- **Partial copy:** rejected; staging is recursively validated and discarded
  when source revision changes.
- **Concurrent refresh:** rejected; lock ownership, stale cleanup, atomic
  rename, rollback, and `finally` cleanup are retained.
- **Status mutation:** rejected; the supported command is read-only and cannot
  write a sidecar or mirror to manufacture pass.
- **Private-content leakage:** rejected; reports expose only bounded results and
  opaque metadata, never instruction contents or secrets.

## Semantic-fidelity final review

The final candidate preserves every ledger row and matches the executable
contracts: source revision and recursive discovery, SHA-256 fingerprints,
projection manifest validation, serialized locking, owned cleanup, staging,
source re-read, rename rollback, fail-closed loading, read-only status, and
four status outcomes. No behavior was added that requires configuring an
account source, changing the projection helper, or publishing a runtime copy.

## General-language final review

The candidate is self-contained, uses direct imperative language, defines
opaque terms at first use, gives the refresh order as numbered steps, and
keeps reporting and ownership actionable. It avoids private implementation
details and does not ask a future agent to consult another skill or file.

## Meaningful changes from the clean-room baseline

- Added a concise trigger and purpose statement.
- Consolidated source authority and one-way boundary rules.
- Made recursive SHA-256 manifest semantics explicit.
- Turned the projection lifecycle into an ordered, recoverable procedure.
- Added bounded read-only status outcomes and a no-mutation rule.
- Added an ownership table and a prohibited-shortcuts checklist.

## Rejected alternatives

1. **Promote the obsolete runtime mirror:** rejected because it reverses the
   account-source authority and could preserve stale or private instructions.
2. **Use a direct canonical-to-runtime copy:** rejected because it bypasses the
   generated projection, source revision checks, and platform ownership.
3. **Use MD5 or timestamps for freshness:** rejected because they do not satisfy
   the merged SHA-256 path-and-byte contract.
4. **Describe only the happy path:** rejected because interrupted refreshes,
   lock ownership, unavailable sources, and source changes must fail safely.

## Retained wording decisions

- “fail closed” is used for unavailable or invalid canonical inputs.
- “disposable” describes runtime mirrors to prevent accidental authority.
- “opaque” prevents consumers from interpreting revision or fingerprint format.
- “bounded result” prevents status/reporting prose from leaking private content.

## Unresolved findings

None. The platform-owned runtime mirror lifecycle remains intentionally outside
repository automation; unknown mirror metadata remains unknown rather than
passing. The account source is not configured or invented by this review.

## Complete final candidate

```markdown
---
name: skill-mirror-sync
description: >-
  Audit, project, verify, or repair account-managed skills and their disposable
  runtime mirrors. Use when source selection, projection freshness, metadata,
  interrupted refreshes, locks, or mirror parity are uncertain.
---

# Skill Mirror Sync

Use this skill for account-managed skill projection and runtime-mirror
investigations. Keep the boundary one-way and fail closed: the account source
is authoritative, the workspace projection is generated, and the runtime
mirror is disposable.

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
  reconstructed registry into tracked repository files.

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

Refresh only through the supported projection helper:

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

An interrupted refresh is handled by the same ownership-safe cleanup on the
next supported refresh. Do not manually rescue partial files, merge staging
contents, or load a prior projection while the source is unavailable.

## Read-only mirror status

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

Status is read-only. Do not write the mirror, sidecar, projection, or source
just to make a check pass. Do not print skill contents, source paths, secrets,
credentials, mirror values, or private account instructions. Missing
authoritative metadata is unknown/unavailable, not a pass. If the platform
does not expose authoritative mirror metadata, parity is unknown.

## Failure ownership and reporting

Classify before remediating:

| Observation | Owner | Repository action |
|---|---|---|
| Account content, revision, or publication is wrong | Account/platform skill owner | Report identity and bounded result; do not patch a mirror |
| Mirror is missing or stale after supported refresh | Account/platform provisioning or sync owner | Report environment, identity, and opaque metadata; request platform remediation |
| Canonical source or validation metadata is unavailable | Account/platform owner | Report unavailable and preserve fail-closed loading |
| Projection implementation, boundary, or focused contract is wrong | Repository maintainer | Fix the repository contract or implementation |

Reports should contain the skill ID, environment, validation surface, bounded
outcome, and opaque revision or SHA-256 fingerprint when available. Include a
timestamp only if the reporting system requires it. Never fabricate a source
path, revision, fingerprint, manifest, sidecar, or success result. Hand-editing
`.local/custom_skills` is never remediation.

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
```

## Read-back verification

The complete candidate, invariant ledger, exactly two brainstorm rounds, exactly
three ordered passes, adversarial checks, both final reviews, meaningful
changes, rejected alternatives, retained wording, unresolved findings, and
`Apply` recommendation are all recorded in this durable package. The package
is outside `.local/`, generated projections, temporary directories, and the
canonical target.
