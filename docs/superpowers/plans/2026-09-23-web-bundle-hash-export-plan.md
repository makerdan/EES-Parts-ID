# Implementation Plan: Web bundle hash export

## Source Spec
- Spec file: `docs/superpowers/specs/2026-09-23-web-bundle-hash-export-design.md`
- Approved by user: 2026-09-23

## Dependencies
- Existing Expo/Metro serializer, Jest test harness, and production web export; no new packages, services, secrets, or migrations.
- A stable non-preview production domain for local build verification.

## Tasks

### T001: Recognize web artifacts without platform metadata
- **Blocked by**: []
- **Files**: `artifacts/parts-id/metro.config.js`
- **Details**: Preserve explicit native-platform pass-through, but allow serialized artifacts with web filename paths through existing sanitization and reference/filename rewriting when the platform is unspecified. Preserve the final build guards.
- **Done when**: An unspecified-platform web entry is sanitized with a hash matching its final bytes; explicit native output remains unchanged.

### T002: Regression hardening — missing-platform export
- **Blocked by**: [T001]
- **Files**: `artifacts/parts-id/__tests__/verifyWebBundleContentHashes.test.ts`
- **Details**: Cover a web entry and lazy chunk with source maps and HTML/metadata references when serializer arguments lack platform metadata; assert sanitization, final hash names, and rewritten references. Retain the native pass-through tests.
- **Done when**: The focused Jest suite passes and fails if the early platform guard is restored.

### T003: Verify production export
- **Blocked by**: [T002]
- **Files**: []
- **Details**: Run the focused test and local production build with a stable non-preview domain; ensure the final contact-data, content-hash, and domain guards pass.
- **Done when**: The production build exits successfully and final hash verification reports success.

## Pre-existing failures to ignore
- The recent ad-hoc fast validation run failed `ci-validation-parity-revision-contract` on stale parity-report revision evidence after unrelated merges; it does not assess the Expo export. Do not modify parity evidence as part of this repair.

## Validation
**Command:** `test-fast`
**Why:** Fast validation checks static contracts and package integrity; the focused serializer suite and production build cover the changed path directly.
**Do not escalate:** Run exactly this tier if completing via the registered validation gate; unrelated failures are not a reason to run heavier tiers.