# Account-level skill validation contract

## Authority and projection boundary

The account/platform-managed skill store is authoritative. It is external to
the repository and is selected for a session by the required
`ACCOUNT_SKILLS_SOURCE` path. A workspace must never invent a fallback source,
use timestamps as revisions, or treat a runtime file as authoritative.

Before a skill is loaded, the account source is read and its non-empty
`.account-revision` value is compared with the local projection. Account skills
are discovered deterministically as immediate source directories containing
`SKILL.md`; every regular supporting file below each directory is projected,
not just the markdown entrypoint. Symlinks and unexpected source entries are
rejected.

The generated projection lives at
`.agents/skills/.account-projections/`. Its `manifest.json` records format,
account revision, each skill's sorted file list, and a SHA-256 fingerprint over
the file paths and bytes. The projection is rebuilt in a staging directory,
validated, and installed under a serialized lock by directory rename. A
missing manifest, missing file, unexpected file, revision mismatch, fingerprint
mismatch, or source change during the copy is an incomplete or stale
projection, never a reason to load old instructions.

This namespace is generated locally and is ignored by git. Workspace-authored
skills elsewhere under `.agents/skills/` are never overwritten or removed.
Account-managed content may only be replaced inside the explicit
`.account-projections` namespace recorded by its manifest. If the account
source is unavailable, invocation fails closed even when an older projection
exists.

The projection helper and invocation loader are repository validation tooling;
they do not edit `.local/custom_skills` and do not publish account content into
tracked files.

## Supported validation surface

The supported repository validation surface is:

1. **Projection checks** — exercise account-to-workspace refresh, recursive
   contents, revisions, fingerprints, ownership protection, atomic installation,
   partial-copy rejection, and fail-closed source handling using isolated
   fixtures.
2. **Boundary checks** — confirm generated account projections are ignored and
   that repository changes do not add a registry, private account content, or
   edits to `.local/custom_skills`.
3. **Runtime mirror checks** — when a platform mirror is present, check its
   expected path, readable identity, and platform-provided revision or opaque
   fingerprint metadata.

A repository check must not hash a runtime mirror against a repository file,
reconstruct an account-level registry, infer a canonical version from file
timestamps, or compare against a copied skill body. The projection check uses
only the supported account source path and its revision. If that source is
unavailable, the invocation result is failed/blocked and stale instructions
are not loaded. If the platform does not expose authoritative metadata for its
disposable runtime mirror, mirror parity is **unknown**, not passing.

The repository may report observations such as mirror missing, mirror
unreadable, metadata mismatch, or canonical metadata unavailable. It must not
claim that the account-level source is current based only on the runtime file.

### Canonical identity and read-only status command

The canonical skill identifier is the validated account-source directory slug
(`<skill-id>`), not the display name in `SKILL.md`. Canonical revision metadata
is the non-empty account-wide `.account-revision` value plus the skill's
SHA-256 fingerprint over its sorted relative file paths and bytes. These values
are opaque identifiers: consumers compare them exactly and do not interpret
their format or derive a revision from timestamps.

The supported repository command is:

```sh
pnpm account-skill:status -- --skill <skill-id>
```

It is non-mutating. It reads `ACCOUNT_SKILLS_SOURCE` and the platform-owned
`.local/custom_skills/<skill-id>/.account-skill-metadata.json` sidecar. The
sidecar has format `1` and the fields `skillId`, `sourceRevision`, and
`fingerprint`. The command prints a fixed JSON schema to stdout: outcome and
canonical skill identity, plus revision and fingerprint when the canonical
source is available, and one bounded reason code for mismatches. It never
echoes mirror values or prints a skill file, secret, credential, or source path.

| Outcome | Exit | Meaning |
|---|---:|---|
| `pass` | 0 | Mirror identity, revision, and fingerprint exactly match the canonical account source |
| `mismatch` | 1 | Mirror metadata is invalid or differs from canonical metadata |
| `unavailable-source` | 2 | The canonical account source or revision metadata cannot be read |
| `missing-mirror` | 3 | The platform mirror metadata sidecar is absent |

Repository consumers may invoke this command and parse its JSON result. They
must not add a skill registry, copy account instructions, or manufacture the
platform sidecar. Absence of authoritative source metadata cannot be converted
to a pass.

## Ownership and failure handling

| Condition | Owning party | Repository response |
|---|---|---|
| Canonical skill content, version, or publication is wrong | Account/platform skill owner | Report the skill identity and observed platform result; do not patch a mirror |
| Runtime mirror is missing or stale after a supported refresh | Account/platform provisioning/sync owner | Report the environment, mirror identity, and opaque metadata; request platform remediation |
| Canonical metadata or validation API is unavailable | Account/platform owner | Mark the result unavailable and preserve fail-closed invocation behavior |
| Repository adds a copied registry, generated account content, or mirror-edit automation | Repository maintainer | Reject the change; remove the repository-owned copy or automation |
| A focused skill contract is incorrect | The owner of that skill's account-level contract | Keep the focused proposal responsible for its own assertions and remediation |

Failures should include the skill identifier, environment, observed revision or
fingerprint (without secrets or skill contents), validation surface, timestamp,
and whether the result is failed, unavailable, or blocked by provisioning.
Remediation must use the supported account source publication path. Hand-editing
`.local/custom_skills/` is never remediation.

## Two-stage mirror contract

The direction is intentionally one-way:

1. account source → local workspace projection at
   `.agents/skills/.account-projections/`; then
2. workspace skill projection/source → disposable runtime mirror at
   `.local/custom_skills/<name>/`.

The runtime mirror is the final downstream copy. It may be refreshed by the
platform or supported post-merge automation and may carry its own opaque
fingerprint, but it must never flow back into the account source or workspace
projection. The repository must not edit `.local/custom_skills` directly.

The supported lifecycle is publication to the account source, platform
provisioning or refresh of the disposable runtime mirror and metadata sidecar,
then read-only verification with `account-skill:status`. A repository restart
may trigger platform provisioning, but repository automation must not simulate
success by writing the sidecar. A missing or stale sidecar after a supported
refresh belongs to the account/platform provisioning and sync owner; an
unavailable canonical source belongs to the account/platform skill owner.

## Rules for future skill-specific proposals

A future proposal may add a skill-specific validation check only after its
account/platform owner supplies all of the following:

- the authoritative account-level skill identifier and ownership contact;
- a supported read-only source or metadata endpoint/command;
- the version or revision representation and comparison semantics;
- the runtime mirror lifecycle and supported refresh procedure;
- the exact exit statuses for pass, mismatch, unavailable source, and missing
  mirror;
- the repository-versus-platform failure owner and escalation path; and
- a statement that the check does not require copying account-level skill
  contents, secrets, or credentials into the repository.

The proposal must preserve the ownership boundary in
`.local/custom_skills/install-github-actions/SKILL.md`: that focused skill
defines its own validation contract and must not be silently replaced by a
generic repository mirror check. `.local/custom_skills/skill-mirror-sync/` is
runtime reference material only; it is never promoted to the account source.