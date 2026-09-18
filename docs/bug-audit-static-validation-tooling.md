# Bug & Error Audit Report

**Scope:** Static validation tooling across the workspace: TypeScript project
coverage, lint and dead-export registration, Jest mock-factory scanning,
environment-reference scanning, production-privacy checks, TypeScript
reference checks, generated-input checks, ignore rules, and validation-tier
registration.
**Mode:** report-only
**Date:** 2026-09-15
**Stack:** TypeScript/TSX, Node.js 24, pnpm workspaces, ESLint, Knip, Jest,
Vitest, Expo, Vite, Orval, and `tsx`. React-specific runtime categories were
reviewed only where a checker claims coverage. This audit does not assess
application runtime behavior.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 6 |
| Low | 1 |

| # | Severity | Category | File:Line | One-line description |
|---:|---|---|---|---|
| 1 | Medium | Type safety | `scripts/validation-steps.mjs:96` | Fast `tsc` omits the TypeScript sources in `lib/api-spec`. |
| 2 | Medium | Dead / unreachable code | `scripts/validation-steps.mjs:97` | Dead-export validation covers only API Server and Canvas, not Parts ID or libraries. |
| 3 | Medium | Type safety | `scripts/src/check-mock-factories.ts:86` | Workspace subpath mocks are silently skipped by the resolver. |
| 4 | Medium | Error handling | `scripts/src/check-tsconfig-refs.ts:25` | Comment stripping corrupts valid string literals before JSON parsing. |
| 5 | Medium | Type safety | `scripts/src/check-tsconfig-refs.ts:52` | The TypeScript-reference scan has a fixed two-level `lib` depth. |
| 6 | Medium | Error handling | `scripts/src/check-env-vars.ts:20` | Environment coverage excludes server-side libraries and the privacy checker itself. |
| 7 | Low | Error handling | `scripts/src/check-mock-factories.ts:153` | Raw-text mock parsing can treat comments or strings as executable mock calls. |

## Validation command inventory

The validation tiers are registered in `scripts/validation-steps.mjs`. The
commands below are the static-validation surfaces relevant to this audit.

| Surface | Registered command | Tier | Effective coverage |
|---|---|---|---|
| TypeScript | `tsc` | `fast` | `tsc --build` for root-referenced `lib` projects, then package `typecheck` scripts under `artifacts/**` and `scripts` |
| Lint | `lint` | `fast` | Parts ID ESLint, API Server ESLint + Knip, Canvas ESLint + Knip, and `eslint lib/` |
| Jest mock factories | `lint-mocks` | `fast` | `scripts/src/check-mock-factories.ts` over API Server, Parts ID, and `lib` test roots |
| TypeScript references | `tsconfig-check` | `fast` | `lib/*/tsconfig.json` and `lib/*/*/tsconfig.json` against root references or opt-out comments |
| API code generation | `codegen-check` | `standard` | Orval regeneration, generated-file diff, route/spec, barrel, and declaration checks |
| API specification | `spec-check` | `standard` | API route drift checker |
| API specification tests | `spec-check-tests` | `standard` | Jest tests in `lib/api-spec` |
| Environment references | `env-check` | `standard` | Direct static `process.env` reads in `artifacts/api-server/src` and `lib/db/src` compared with `.env.example` |
| Production privacy | `privacy-check` | `standard` | Production CORS is fatal; missing privacy key material is a warning; local mode intentionally does not enforce production-only failures |
| Privacy contract | `privacy-check-contract` | `standard` | Contract tests for the production-privacy checker |
| Dependency/security contracts | `dependency-security-contract`, `patched-dependencies` | `fast` | Repository-specific dependency policy and patch checks |
| Full dependency audit | `security-audit` | `standard-plus` / `heavy` | `pnpm audit --audit-level=low`; not run under this task’s validation ceiling |

### Package boundary observations

- API Server and Canvas run Knip through their `lint` scripts.
- Parts ID runs ESLint but has no Knip/dead-export script.
- Libraries run ESLint through the root `lint:libs` script but have no
  dead-export command.
- `lib/api-spec` has TypeScript sources and codegen/spec/test scripts, but no
  `tsconfig.json` or package `typecheck` script.
- The mock-factory checker scans Jest test roots. Canvas tests use Vitest and
  are not Jest mock-factory inputs.
- Generated API client and Zod files are regenerated and diff-checked by the
  standard codegen command; the generated directories are excluded from the
  library ESLint configuration.

## Baseline results

The mandated command was run before the audit report was written:

```text
pnpm run test-fast
```

Result: **passed, 27/27 steps**.

Notable static results:

- Root and package TypeScript checks passed.
- ESLint and registered Knip checks passed.
- Mock-factory and TypeScript-reference checks passed.
- The public-repository boundary step passed while reporting historical private
  paths for the separate owner-led remediation task.
- Full application tests and `pnpm audit` were not run because the task plan
  explicitly locks validation to `pnpm run test-fast`.

## Findings

### Finding 1 — API-spec TypeScript is outside the fast typecheck graph

- **File and line:** `scripts/validation-steps.mjs:96`; `lib/api-spec/package.json:6-14`
- **Category:** Type safety
- **Severity:** Medium
- **Risk:** `lib/api-spec` contains seven TypeScript files, including the
  route-drift, barrel, declaration, dependency-floor, and test helpers, but it
  has no `tsconfig.json` and no package `typecheck` script. The fast `tsc`
  command typechecks root-referenced libraries and package typecheck scripts
  under `artifacts/**` and `scripts`, so these sources are not part of the
  fast TypeScript graph. A type error in a codegen/spec checker can therefore
  survive fast validation and fail only when `tsx` executes the standard
  codegen or spec command.
- **Recommended fix:** Add an explicit TypeScript project/typecheck surface
  for `lib/api-spec`, or register an equivalent package-scoped typecheck in
  the `tsc` validation command. Keep generated-input checks separate from the
  source typecheck.

### Finding 2 — Dead-export coverage stops at two artifacts

- **File and line:** `scripts/validation-steps.mjs:97`;
  `artifacts/parts-id/package.json:15-27`; `package.json:22`
- **Category:** Dead / unreachable code
- **Severity:** Medium
- **Risk:** API Server and Canvas invoke Knip, but Parts ID has only an ESLint
  lint script, and the root `lint:libs` command runs ESLint only. No registered
  fast or standard command checks unused exports, unreachable entry points, or
  stale files in Parts ID or the workspace libraries. A removed route/helper
  can therefore remain exported and appear healthy while no checker reports
  the dead boundary.
- **Recommended fix:** Define deliberate Knip entry/configuration boundaries
  for Parts ID and the libraries, or document and enforce an equivalent
  dead-code policy for every package. Generated code and platform entry points
  should remain explicit exclusions rather than relying on package omission.

### Finding 3 — Mock-factory checking silently skips workspace subpaths

- **File and line:** `scripts/src/check-mock-factories.ts:86-93`
- **Category:** Type safety
- **Severity:** Medium
- **Risk:** `resolveModulePath` maps only an exact `@workspace/<name>` key to
  that package’s `src/index.ts`. It returns `null` for
  `@workspace/<name>/subpath`, so the checker never inspects those mocked
  modules. The repository currently contains 68 Jest mocks of workspace
  subpaths, including repeated mocks of
  `@workspace/integrations-openai-ai-server/batch`. Those current subpaths do
  not expose the class pattern that triggered this checker, but if a subpath
  later exports an error or other class, a factory that breaks class identity
  would pass `lint:mocks` silently.
- **Recommended fix:** Resolve workspace package subpaths using the package
  export/source layout and inspect the resolved module, or fail closed when a
  workspace mock cannot be resolved. Add a fixture for a class-exporting
  subpath.

### Finding 4 — TypeScript-reference parsing is unsafe for string literals

- **File and line:** `scripts/src/check-tsconfig-refs.ts:25-30`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The checker removes `//...` and `/*...*/` with regular expressions
  before calling `JSON.parse`. A valid JSONC string containing a URL such as
  `https://example.test/tsconfig`, or text containing `/*...*/`, is truncated
  before parsing. A root TypeScript configuration that adds such a string will
  make `tsconfig:check` terminate with an uncaught JSON parse error instead of
  reporting reference coverage. This was reproduced with a minimal config
  string; the current root config does not contain the triggering literal.
- **Recommended fix:** Parse TypeScript configuration with a JSONC-aware parser
  that distinguishes comments from string contents, and turn malformed
  configuration into an explicit diagnostic with a controlled exit.

### Finding 5 — TypeScript-reference discovery is bounded to two `lib` levels

- **File and line:** `scripts/src/check-tsconfig-refs.ts:52-60`
- **Category:** Type safety
- **Severity:** Medium
- **Risk:** The checker searches only `lib/*/tsconfig.json` and
  `lib/*/*/tsconfig.json`. A future package at a deeper path, or a nested
  package introduced by a workspace refactor, is invisible to
  `tsconfig:check`; its type errors can be absent from root `tsc --build`
  without an opt-out diagnostic. All current eight library projects are at
  the supported depths and pass, so this is a verified false-negative path
  rather than a current unregistered package.
- **Recommended fix:** Discover `tsconfig.json` recursively under the
  workspace’s declared library roots, or derive the package set from the
  workspace manifest and explicitly validate every package depth.

### Finding 6 — Environment-reference coverage does not follow server package boundaries

- **File and line:** `scripts/src/check-env-vars.ts:20-23,54-65,75-89`;
  `scripts/src/check-production-privacy.ts:13-20`
- **Category:** Error handling
- **Severity:** Medium
- **Risk:** The environment checker recursively scans only `.ts` files under
  `artifacts/api-server/src` and `lib/db/src`. It does not scan the
  server-side integration libraries under `lib/integrations-*`, the
  `scripts/src` privacy checker, or non-TypeScript server entrypoints. The
  excluded production code currently reads provider secrets, and the privacy
  checker reads `VISITOR_PRIVACY_SECRET`, `SESSION_SECRET`, and
  `CORS_ALLOWED_ORIGINS`. Those values happen to be documented today and API
  server validation covers the current provider contract, but deleting or
  adding a variable only in one excluded package would leave `env:check`
  green.
- **Recommended fix:** Define the server package boundary once and scan all
  production server sources in it, including supported extensions. Keep test
  and client-only variables in explicit, reviewed allowlists; avoid silently
  treating omitted directories as documentation.

### Finding 7 — Mock-factory parsing is raw-text rather than syntax-aware

- **File and line:** `scripts/src/check-mock-factories.ts:153-177`
- **Category:** Error handling
- **Severity:** Low
- **Risk:** The parser searches raw source for `jest.mock(` and balances
  parentheses while recognizing only quoted strings. It does not skip comments,
  regular-expression literals, or template interpolation. A comment or string
  containing a mock-like fragment can therefore be treated as a real call, and
  punctuation in a comment or regex can shift the balanced-call boundary. The
  current repository produced no such false-positive output, but the behavior
  is confirmed by the parser strategy and makes validation sensitive to
  harmless test documentation or fixture text.
- **Recommended fix:** Use a TypeScript/JavaScript parser to identify actual
  call expressions and inspect the second argument’s AST, or add a focused
  syntax-fixture suite that proves comments, strings, regexes, and template
  literals are ignored.

## Ten-category audit triage

| Category | Result |
|---|---|
| Null / undefined safety | No confirmed checker defect. The audit focused on static-tool inputs rather than application values. |
| Async & timing | No confirmed defect. The TypeScript-reference scan’s async glob iteration completed and the fast tier passed. |
| Error handling | Findings 4, 6, and 7: uncontrolled JSONC parsing, excluded environment boundaries, and raw-text mock parsing. |
| Type safety | Findings 1, 3, and 5: omitted TypeScript project coverage, unresolved mock subpaths, and fixed-depth reference discovery. |
| State & data integrity | No confirmed defect in the checked scripts. Generated API inputs are regenerated and diff-checked in standard validation. |
| Security | No confirmed new security defect. The privacy checker avoids printing secret values, and production CORS failure behavior was verified by focused runs. |
| Performance | No confirmed release-blocking defect. `parseMockCalls` has a repeated offset-to-line scan, but the current fast run completed successfully. |
| Concurrency & shared state | No confirmed defect in these static checkers. The validation runner’s serialized resource behavior is covered by existing fast contracts. |
| Dead / unreachable code | Finding 2: dead-export checks are not registered for Parts ID or libraries. |
| Dependency hygiene | No new finding. The fast dependency-security and patched-dependency contracts passed; the full audit was outside the locked tier. |

## Intentional policies and unverified candidates

- `privacy:check` exits successfully in local validation mode even when
  production CORS is absent. This is documented behavior, and the production
  branch fails when `NODE_ENV=production` or `REPLIT_DEPLOYMENT=1`.
- The environment checker’s `EXPO_PUBLIC_*`, `DATABASE_ENV`, and Gemini
  contract-only handling are explicit policy choices. They should remain
  reviewed allowlists, not be treated as proof of complete environment
  discovery.
- Generated API sources are intentionally validated through regeneration and
  diff checks. This audit did not classify generated-file exclusion from ESLint
  as a defect.
- Runtime application behavior, database behavior, full test suites, and the
  standard-plus dependency audit were not audited because they are outside this
  static-tooling report and the task’s validation ceiling.

## No-fix confirmation

This was a report-only audit. No static checker, package dependency,
TypeScript configuration, lint configuration, validation-tier registration, or
application source was changed. The only repository change is this report.