# Account-level skill validation contract

## Status

This repository does not own the canonical source for account-level skills. The
authoritative source is the account/platform-managed skill store that publishes
skills into the development environment. It is outside the repository and is
owned by the account/platform skill maintainers.

`.local/custom_skills/<name>/SKILL.md` is a runtime mirror supplied by that
platform. It is useful evidence about what this environment received, but it is
not the source of truth and must not be edited, committed, or used to establish
the canonical content. The tracked `.agents/skills/` directory is likewise not
an account-level registry.

## Supported validation surface

Until the account/platform owner publishes a supported, read-only interface for
the canonical store, repository validation is limited to the following:

1. **Boundary checks** — confirm that repository changes do not add a skill
   registry, copy account-level skill content into tracked files, or edit
   platform-managed `.local/custom_skills/` mirrors.
2. **Runtime mirror checks** — when a mirror is present, check its expected
   path, readable frontmatter/identity, and any version, revision, or opaque
   fingerprint metadata that the platform explicitly exposes for that mirror.
3. **Supported refresh checks** — verify that the platform's documented install
   or refresh path can be invoked by the account/platform owner and that the
   resulting mirror reports the expected platform metadata.

A repository check must not hash a runtime mirror against a repository file,
reconstruct an account-level registry, infer a canonical version from file
timestamps, or compare against a copied skill body. If the platform does not
expose authoritative metadata for a mirror, canonical-content parity is
**unknown**, not passing and not a repository failure.

The repository may report observations such as mirror missing, mirror
unreadable, metadata mismatch, or canonical metadata unavailable. It must not
claim that the account-level source is current based only on the runtime file.

## Ownership and failure handling

| Condition | Owning party | Repository response |
|---|---|---|
| Canonical skill content, version, or publication is wrong | Account/platform skill owner | Report the skill identity and observed platform result; do not patch a mirror |
| Runtime mirror is missing or stale after a supported refresh | Account/platform provisioning/sync owner | Report the environment, mirror identity, and opaque metadata; request platform remediation |
| Canonical metadata or validation API is unavailable | Account/platform owner | Mark the result unknown and preserve fail-closed behavior for any check declared required by the account/platform contract |
| Repository adds a copied registry, canonical content, or mirror-edit automation | Repository maintainer | Reject the change; remove the repository-owned copy or automation |
| A focused skill contract is incorrect | The owner of that skill's account-level contract | Keep the focused proposal responsible for its own assertions and remediation |

Failures should include the skill identifier, environment, observed
platform-provided metadata (without secrets or skill contents), validation
surface, timestamp, and whether the result is failed, unknown, or blocked by
provisioning. Remediation must use the supported account/platform refresh or
publication path. Hand-editing `.local/custom_skills/` is never remediation.

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
generic repository mirror check. The existing
`.local/custom_skills/skill-mirror-sync/SKILL.md` is reference material only; it
must not be promoted to the account-level source of truth.