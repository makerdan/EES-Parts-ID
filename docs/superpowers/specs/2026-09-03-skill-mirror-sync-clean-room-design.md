# Skill Mirror Sync Clean-Room Replacement Design

## Goal

Create a new canonical, self-contained Skill Mirror Sync at
`.agents/skills/skill-mirror-sync/SKILL.md`. The skill will teach future agents
how to audit, project, verify, and safely recover account-managed skills using
the contracts established by Tasks #1056, #1065, #1077, and #1078.

This is a clean-room replacement. The obsolete runtime file at
`.local/custom_skills/skill-mirror-sync/SKILL.md` is reference material only and
will not be copied, edited, promoted, or treated as an authoritative baseline.

## Scope

### In scope

- Create the canonical `SKILL.md` under `.agents/skills/skill-mirror-sync/`.
- Preserve the skill identity and broad trigger intent.
- Make the skill self-contained and portable while retaining exact safety
  boundaries.
- Add focused contract assertions to
  `scripts/test/skill-mirror-sync-contract.test.mjs`.
- Run the Skill Compression review sequence against the clean-room candidate.
- Save a durable compression review outside the canonical source and `.local/`.

### Out of scope

- Editing `.local/custom_skills/`.
- Copying private account-level skill instructions into the repository.
- Creating or guessing an account-level source path.
- Changing the projection implementation or status command.
- Publishing or modifying account/platform-managed skills.

## Source of Truth

The new skill derives its requirements from the merged repository contracts,
not the obsolete runtime mirror:

- `docs/validation/account-level-skills.md`
- `scripts/account-skill-status.mjs`
- `scripts/lib/account-skill-projection.mjs`
- `scripts/test/skill-mirror-sync-contract.test.mjs`

The skill must remain consistent with current behavior in those files. If prose
and executable behavior conflict, implementation and focused tests control; the
conflict must be reported rather than silently resolved.

## Skill Content

The self-contained skill will include:

1. **Purpose and triggers**
   - Adding, auditing, invoking, validating, or repairing an account-managed
     skill projection.
   - Investigating source, projection, metadata, runtime-mirror, or interrupted
     refresh failures.

2. **Authority and direction**
   - The account/platform source selected by `ACCOUNT_SKILLS_SOURCE` is
     authoritative.
   - The generated workspace projection lives only under
     `.agents/skills/.account-projections/`.
   - Runtime mirrors under `.local/custom_skills/` are disposable downstream
     copies and never flow back into a source or projection.

3. **Source and manifest requirements**
   - Non-empty `.account-revision`.
   - Immediate skill directories containing `SKILL.md`.
   - Recursive regular-file discovery with symlink and unexpected-entry
     rejection.
   - Sorted file lists and SHA-256 fingerprints over file paths and bytes.

4. **Safe projection workflow**
   - Require an explicit source; never invent a fallback.
   - Acquire the serialized ownership-aware lock.
   - Recover only provably abandoned or stale lock artifacts.
   - Remove only helper-owned stale staging and backup directories.
   - Build and validate in staging.
   - Re-read source revision before installation.
   - Install by guarded directory rename with rollback protection.
   - Validate again before loading.

5. **Read-only verification**
   - Use the supported status command and metadata path.
   - Distinguish current, mismatch, unavailable, and blocked results.
   - Never reveal or copy private skill contents merely to prove freshness.
   - Treat missing authoritative metadata as unknown/unavailable, not passing.

6. **Failure ownership and remediation**
   - Account content/publication problems belong to the account/platform owner.
   - Runtime mirror provisioning problems belong to the platform sync owner.
   - Repository projection implementation or boundary failures belong to the
     repository maintainer.
   - Never remediate by editing `.local/custom_skills/` or fabricating
     fingerprints, revisions, manifests, or source paths.

7. **Operational output**
   - Report skill identity, environment, observed revision or opaque
     fingerprint when available, validation surface, result classification,
     and failure owner without exposing instruction contents or secrets.

## Skill Compression Review

Because no authoritative prior `SKILL.md` is available, the immutable baseline
is this approved design plus the four repository contracts listed above. The
obsolete runtime mirror is not `B0`.

Before application:

1. Produce a complete clean-room candidate and invariant ledger.
2. Run exactly two brainstorm-and-iterate rounds.
3. Run exactly three ordered passes:
   - remove redundancy;
   - clarify decision boundaries;
   - polish language and ordering.
4. Perform semantic-fidelity and general-language reviews.
5. Save the complete review package under
   `skill-previews/skill-mirror-sync/` with a unique filename.
6. Read the preview back and verify it contains the complete candidate,
   invariants, meaningful changes, rejected alternatives, findings, and
   recommendation.
7. Apply the candidate only if the recommendation is `Apply`.

## Regression Hardening

Extend `scripts/test/skill-mirror-sync-contract.test.mjs` to read the new
canonical skill and prove that it:

- names `ACCOUNT_SKILLS_SOURCE` as authoritative;
- names `.agents/skills/.account-projections/` as generated output;
- requires recursive SHA-256 manifest validation;
- includes read-only status verification;
- includes serialized atomic installation and interrupted-refresh cleanup;
- forbids direct `.local/custom_skills/` edits and reverse promotion; and
- does not endorse MD5 or a direct canonical-to-runtime copy workflow.

These assertions supplement, rather than replace, the existing behavioral
tests for projection freshness, atomicity, lock recovery, cleanup ownership,
and fail-closed loading.

## Validation

- Run `node scripts/test/skill-mirror-sync-contract.test.mjs`.
- Run the registered `test-fast` tier because the change is limited to
  instructional text and its focused static/behavioral contract.
- Do not escalate to a heavier tier unless the implementation expands beyond
  this specification.

## Acceptance Criteria

1. `.agents/skills/skill-mirror-sync/SKILL.md` exists with valid lowercase
   frontmatter identity and remains under 500 lines.
2. A future agent can follow the complete source → projection → runtime
   direction without reading the implementation first.
3. The skill explicitly handles unavailable sources, metadata mismatch,
   concurrent refreshes, abandoned locks, interrupted staging, and ownership.
4. The skill contains no instruction to edit or reverse-copy a runtime mirror.
5. The durable compression review recommends `Apply` and passes read-back
   verification.
6. The focused contract and `test-fast` pass, apart from failures proven to
   predate this work.