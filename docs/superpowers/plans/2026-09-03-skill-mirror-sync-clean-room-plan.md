# Implementation Plan: Skill Mirror Sync Clean-Room Replacement

## Source Spec
- Spec file: `docs/superpowers/specs/2026-09-03-skill-mirror-sync-clean-room-design.md`
- Approved by user: 2026-09-03

## Dependencies
- Existing account-skill contracts in
  `docs/validation/account-level-skills.md`,
  `scripts/account-skill-status.mjs`,
  `scripts/lib/account-skill-projection.mjs`, and
  `scripts/test/skill-mirror-sync-contract.test.mjs`
- Existing Skill Compression instructions at
  `.local/custom_skills/skill-compression/SKILL.md`
- No package, migration, deployment, secret, or configured
  `ACCOUNT_SKILLS_SOURCE` is required to author and statically validate the
  clean-room skill

## Tasks

### T001: Produce the durable Skill Compression candidate and review
- **Blocked by**: []
- **Files**:
  `skill-previews/skill-mirror-sync/2026-09-03-clean-room-p3.md`
- **Details**: Treat the approved design and four repository contracts as the
  clean-room baseline; do not use the obsolete `.local` runtime mirror as
  `B0`. Record the target identity, scope, source status, immutable contract
  evidence, and a complete invariant ledger covering triggers, requirements,
  workflow ordering, safety boundaries, inputs, outputs, exceptions,
  escalation, and file/tool constraints. Produce a complete candidate through
  exactly two brainstorm-and-iterate rounds followed by exactly three ordered
  passes: redundancy removal, decision-boundary clarification, then language
  and ordering polish. Include adversarial checks, semantic and general-language
  final reviews, meaningful candidate diffs, rejected alternatives, retained
  wording, unresolved findings, and an `Apply` or `Reject` recommendation.
  Read the saved review back and verify that it is complete and outside
  `.local/`, generated projections, temporary paths, and the canonical target.
- **Done when**: The durable preview contains the complete final candidate and
  every required Skill Compression review artifact, its read-back matches the
  intended contents, and its recommendation is `Apply`.

### T002: Create the canonical Skill Mirror Sync
- **Blocked by**: [T001]
- **Files**: `.agents/skills/skill-mirror-sync/SKILL.md`
- **Details**: Apply the approved candidate exactly as the new canonical,
  self-contained skill. Use valid lowercase frontmatter identity
  `skill-mirror-sync` and a trigger-rich description. Cover the authoritative
  account source, explicit `ACCOUNT_SKILLS_SOURCE`, revision and recursive
  source rules, SHA-256 manifests, generated projection boundary, serialized
  atomic installation, source-change detection, ownership-safe stale cleanup,
  fail-closed loading, read-only status verification, failure ownership, and
  safe reporting. Explicitly forbid fallback sources, MD5-only validation,
  direct `.local/custom_skills` edits, reverse promotion, fabricated metadata,
  and exposure of private skill contents. Leave the existing runtime mirror
  untouched.
- **Done when**: The canonical file exists, has valid frontmatter, is under 500
  lines, is self-contained, and a future agent can follow the complete
  account-source → generated-projection → runtime-mirror direction without
  consulting implementation code.

### T003: Regression hardening — reject obsolete mirror-sync instructions
- **Blocked by**: [T002]
- **Files**: `scripts/test/skill-mirror-sync-contract.test.mjs`
- **Details**: Extend the existing focused contract to read the new canonical
  skill and assert that it names `ACCOUNT_SKILLS_SOURCE` as authoritative,
  identifies `.agents/skills/.account-projections/` as generated output,
  requires recursive SHA-256 manifest validation, documents read-only status
  verification, includes serialized atomic installation and interrupted-refresh
  cleanup, and forbids direct `.local/custom_skills` edits or reverse promotion.
  Add negative assertions rejecting MD5 as the authoritative fingerprint and
  rejecting a direct workspace-canonical-to-runtime copy workflow. Preserve all
  existing behavioral projection tests.
- **Done when**: The focused contract fails against the obsolete runtime skill,
  passes against the new canonical skill, and all existing projection,
  freshness, ownership, atomicity, cleanup, and fail-closed assertions remain
  green.

### T004: Confirm and harden the installed skill
- **Blocked by**: [T002, T003]
- **Files**: `.agents/skills/skill-mirror-sync/SKILL.md`
- **Details**: Re-read the installed skill cold against the approved
  specification and T002 acceptance criteria. List every discovered gap before
  patching. Limit any corrections strictly to the canonical skill file; do not
  modify adjacent skills, implementation scripts, tests, or runtime mirrors in
  this confirmation step. Stop rather than silently broadening scope if more
  than half the skill would require rewriting.
- **Done when**: Every T002 acceptance criterion remains observable, no section
  is vague, self-referential, or deferred to future work, and a future agent
  reading the skill cold can follow it without ambiguity.

### T005: Validate the canonical skill and repository contract
- **Blocked by**: [T003, T004]
- **Files**: No additional files
- **Details**: Run
  `node scripts/test/skill-mirror-sync-contract.test.mjs`, validate frontmatter
  and line count, scan tracked changes to confirm `.local/custom_skills` and
  `.agents/skills/.account-projections` were not modified, then run the
  registered `test-fast` tier. Treat only the failures documented below as
  pre-existing.
- **Done when**: The focused contract passes, canonical-source and boundary
  checks pass, and `test-fast` either passes or fails only with the three
  documented pre-existing mock-factory violations.

## Pre-existing failures to ignore
These failures exist on `main` before this task starts. Do not investigate or
fix them.

- **`artifacts/api-server/__tests__/inventoryEdit.integration.test.ts` mock factory** — does not preserve the newly exported `MalformedAiResponseError`.
- **`artifacts/api-server/src/__tests__/addPartZodGuard.test.ts` mock factory** — does not preserve the newly exported `MalformedAiResponseError`.
- **`artifacts/api-server/src/__tests__/inventoryEditRoutes.test.ts` mock factory** — does not preserve the newly exported `MalformedAiResponseError`.

**Flaky-test rule:** If a test not listed above fails, retry it 3× in isolation
before concluding it is a regression caused by this task. Only treat a
consistent 3/3 failure as task-owned.

If the only remaining failures are those listed above, plus any failures
self-classified with the Failure Gate evidence rules, the implementation is
cleared to complete without fixing unrelated application tests.

## Validation
**Command:** `test-fast`
**Why:** The change adds one instructional source file and focused static
contract assertions; the fast tier covers the contract, TypeScript, lint,
repository boundaries, and skill validation without running unrelated
application suites.
**Do not escalate:** Run exactly this command. Pre-existing failures are
handled above and are never a reason to run a heavier tier.

## Validation tier
fast