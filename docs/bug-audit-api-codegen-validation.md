# Bug & Error Audit Report

**Scope:** API specification and generated-contract validation: OpenAPI input, Orval generation, generated Zod and React clients, barrel and declaration checks, idempotent ensure behavior, post-merge recovery, and validation-tier wiring.
**Mode:** report-only
**Date:** 2026-09-15
**Stack:** TypeScript/JavaScript, Orval 8.22.0, Zod, React Query, pnpm workspace, Bash recovery scripts, Jest/ts-jest. Type-safety, async/timing, error handling, state/data integrity, concurrency, dead-code, and dependency-hygiene categories were applicable. React rendering-specific checks were not applicable to this generator boundary. Security was limited to codegen/dependency-boundary checks; no credential or route-business-logic audit was performed.

## Pipeline map

| Stage | Inputs / command | Outputs or gate |
|---|---|---|
| Specification | `lib/api-spec/openapi.yaml` | OpenAPI paths, schemas, request/response contracts |
| Generator configuration | `lib/api-spec/orval.config.ts`, `lib/api-spec/post-codegen.mjs` | Orval targets, title transformer, React barrel normalization |
| Generation | `pnpm --filter @workspace/api-spec run codegen` | `lib/api-zod/src/generated/**`, `lib/api-client-react/src/generated/**`; then workspace declaration build |
| Idempotent boot guard | `pnpm --filter @workspace/api-spec run codegen:ensure` | Input-hash marker, lock, required-output probe |
| Specification drift | `spec:check` | Route/spec coverage and selected handcrafted Zod checks |
| React barrel validation | `barrel:check` | Reachability of names from the two React generated files through `api-client-react/src/index.ts` |
| Declaration validation | `dist:check` | Four React declaration files compared to a temporary TypeScript emit |
| Generated-source drift | `codegen:check` | `git diff` over the two generated source directories |
| Post-merge recovery | `scripts/post-merge.sh` → `codegen:fix` | Serialized recovery attempt, generated-source auto-commit, two sentinel checks, API health |
| Validation wiring | `scripts/validation-steps.mjs` | `codegen-check` in standard and higher tiers; `test-fast` exercises contract guards but not the standard codegen step |

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 4 |
| Medium | 3 |
| Low | 0 |

| # | Severity | Category | File:Line | One-line description |
|---:|---|---|---|---|
| 1 | High | Concurrency & shared state | `lib/api-spec/scripts/ensure-codegen.mjs:71-73`, `scripts/post-merge.sh:336-345` | Boot-time codegen and post-merge codegen use independent locks, so destructive Orval cleanup can overlap an import. |
| 2 | High | Concurrency & shared state | `lib/api-spec/scripts/ensure-codegen.mjs:196-203` | Dead-owner recovery can remove a replacement owner’s newly acquired lock. |
| 3 | High | Error handling | `scripts/post-merge.sh:82-95,348-355` | Post-merge recovery checks only two of the generated outputs that the guard and package exports require. |
| 4 | High | State & data integrity | `lib/api-spec/package.json:8`, `lib/api-spec/src/check-dist-declarations.ts:31-77` | The published `api-zod` declaration contract is outside the declaration check. |
| 5 | Medium | State & data integrity | `lib/api-spec/scripts/ensure-codegen.mjs:54-59,89-101` | The ensure marker does not include the generator dependency/toolchain inputs. |
| 6 | Medium | State & data integrity | `lib/api-spec/src/check-dist-declarations.ts:72-139` | React declaration validation ignores extra or stale declaration files. |
| 7 | Medium | State & data integrity | `lib/api-spec/package.json:8`, `lib/api-spec/src/check-barrel.ts:112-115` | Generated source additions that are untracked by Git can pass the drift and barrel gates. |

## Findings

### Finding 1 — Boot and post-merge codegen do not share a lock

- **File and line:** `lib/api-spec/scripts/ensure-codegen.mjs:71-73,182-210`; `scripts/post-merge.sh:336-345`; `scripts/serial-lock.mjs:111-117`
- **Category:** Concurrency & shared state
- **Severity:** High
- **Risk:** `codegen:ensure` protects Orval’s `clean: true` run with `lib/api-spec/.cache/codegen.lock`, while post-merge invokes `codegen:fix` under the unrelated `.local/serial-codegen.lock`. A running development workflow can therefore finish its ensure check and start importing the generated barrel while post-merge deletes and rewrites the same generated directories. The result can be the documented `ERR_MODULE_NOT_FOUND` startup failure, or a process observing a mixed Zod/client contract. The existing post-merge tests mock the serialized wrapper and do not exercise coordination with `codegen:ensure`.
- **Recommended fix:** Define one shared lock resource and require both `codegen:ensure` and post-merge codegen to acquire it before any clean-and-rewrite operation. Add a two-process test that overlaps the boot guard and post-merge command and asserts that no import can observe the clean window.

### Finding 2 — Dead-lock recovery has a remove-after-check race

- **File and line:** `lib/api-spec/scripts/ensure-codegen.mjs:154-173,182-210`
- **Category:** Concurrency & shared state
- **Severity:** High
- **Risk:** A waiter reads a dead owner in `ownerIsDead()` and then recursively removes `lockDir` in a separate operation. The original owner can release the directory after the liveness read; another waiter can then atomically create a new lock and become its owner before the first waiter calls `rmSync(lockDir)`. The first waiter can delete that replacement lock and proceed into `runCodegen()` without protection, allowing overlapping destructive generation or an import during cleanup.
- **Recommended fix:** Make stale-owner reclamation conditional on an owner token/version that is compared and removed atomically, or use an OS-backed lock primitive whose release cannot delete a successor’s lock. Add a forced interleaving regression test for release → replacement acquire → stale cleanup.

### Finding 3 — Post-merge recovery can report success with an incomplete generated tree

- **File and line:** `scripts/post-merge.sh:61-95,315-355`; `lib/api-spec/scripts/ensure-codegen.mjs:61-69,104-119`; `lib/api-spec/orval.config.ts:53-60`
- **Category:** Error handling
- **Severity:** High
- **Risk:** Post-merge only checks `lib/api-zod/src/generated/api.ts` and `lib/api-client-react/src/generated/api.ts`. The ensure guard additionally requires `api-client-react/src/generated/api.schemas.ts` and a non-empty Zod `generated/types` directory, and the React barrel explicitly exports `api.schemas.ts`. If a codegen interruption or output-layout change leaves the two sentinel files non-empty while those required outputs are missing or empty, post-merge logs that recovery succeeded and proceeds to health checks. The next API/client import can then fail or expose an incomplete contract.
- **Recommended fix:** Centralize the required-output manifest so post-merge and `codegen:ensure` validate the same files/directories, including non-empty checks. Test missing `api.schemas.ts`, an empty required Zod type file, and a changed output layout independently.

### Finding 4 — `api-zod`’s published declaration contract is not checked

- **File and line:** `lib/api-spec/package.json:8,13`; `lib/api-spec/src/check-dist-declarations.ts:31-33,72-77,120-139`; `lib/api-zod/package.json:6-12`
- **Category:** State & data integrity
- **Severity:** High
- **Risk:** `codegen:check` runs a React-only `dist:check`, while `@workspace/api-zod` exposes `./dist/index.d.ts` through both `exports` and `types`. A stale, partial, or missing `lib/api-zod/dist/index.d.ts` or `dist/generated/api.d.ts` can therefore be consumed by TypeScript consumers while generated source drift, route/spec checks, the React barrel check, and the React declaration check all pass. This is especially dangerous after an interrupted declaration build because the source Zod tree can look current while the package’s declared type entry remains old or empty.
- **Recommended fix:** Add an equivalent declaration check for the complete `api-zod` source tree, including its barrel and generated declarations, and make the validation contract explicitly establish the required build output before consumers resolve the package `types` entry.

### Finding 5 — The ensure cache key omits generator dependency inputs

- **File and line:** `lib/api-spec/scripts/ensure-codegen.mjs:54-59,89-101,248-253`; `lib/api-spec/package.json:6`
- **Category:** State & data integrity
- **Severity:** Medium
- **Risk:** The persisted marker hashes only `openapi.yaml`, `orval.config.ts`, and `post-codegen.mjs`. It does not include `lib/api-spec/package.json`, `pnpm-lock.yaml`, or the resolved Orval/toolchain versions that produce the output. If Orval or a relevant generator dependency changes while those three files remain unchanged, the marker can still match and all three sentinel checks can pass, causing `codegen:ensure` to skip generation and leave clients produced by the old toolchain.
- **Recommended fix:** Include the generator package manifest and lockfile resolution (or a stable resolved toolchain fingerprint) in the marker inputs. Add a test that changes the generator version/resolution while preserving the three current files and requires regeneration.

### Finding 6 — React declaration checking ignores extra stale declarations

- **File and line:** `lib/api-spec/src/check-dist-declarations.ts:72-77,118-139`
- **Category:** State & data integrity
- **Severity:** Medium
- **Risk:** The checker compares exactly four hard-coded `.d.ts` paths. It never inventories `dist/**/*.d.ts`, rejects obsolete declarations, or compares declaration-map companions. An old generated declaration such as `dist/generated/old-contract.d.ts` can remain in the package output and be resolved by a consumer while `dist:check` passes, creating an inconsistent declaration surface.
- **Recommended fix:** Enumerate the complete emitted declaration tree, compare every expected file, and fail on unexpected stale files. Keep the expected file list derived from the current source/build output rather than only the four known paths.

### Finding 7 — Untracked generated source additions are invisible to drift validation

- **File and line:** `lib/api-spec/package.json:8-9`; `lib/api-spec/src/check-barrel.ts:106-115`; `lib/api-spec/scripts/ensure-codegen.mjs:61-69,104-119`
- **Category:** State & data integrity
- **Severity:** Medium
- **Risk:** `git diff --exit-code` does not report untracked files. A generated `.ts` file added under either generated directory can therefore coexist with a clean generated-source diff. The barrel check derives its required names only from the two current React files, and the ensure probe checks only three files plus directory non-emptiness, so an extra stale or partial generated artifact is not rejected. This can occur after a generator output rename/removal or a local interrupted/manual generation leaves files outside the tracked set.
- **Recommended fix:** Compare the generated directory inventory against the generator’s expected file set and explicitly fail on untracked or unexpected files. Use a tracked-file-aware check rather than relying on `git diff` alone.

## Ten-category audit disposition

1. **Null / undefined safety:** No verified finding in the generator scripts; file reads and JSON parsing generally have explicit failure paths. Missing-output handling is reported under Findings 3 and 4.
2. **Async & timing:** No promise lifecycle issue was found; the material timing risks are the codegen lock races in Findings 1 and 2.
3. **Error handling:** Finding 3 covers a verified misleading-success path in post-merge recovery.
4. **Type safety:** Applicable because the checks and outputs are TypeScript. No separate `any`/assertion finding was verified; declaration coverage is reported under Findings 4 and 6.
5. **State & data integrity:** Findings 4–7 cover stale, partial, and inconsistent generated contracts.
6. **Security:** Dependency-floor validation exists and no codegen-boundary credential or command-injection finding was verified. API business-logic authorization was out of scope.
7. **Performance:** No independent performance defect was verified; the ensure fast path is the relevant optimization, and its stale-input behavior is Finding 5.
8. **Concurrency & shared state:** Findings 1 and 2 cover independent-lock and stale-lock reclamation races.
9. **Dead / unreachable code:** No verified dead-code finding in the audited paths.
10. **Dependency hygiene:** The dependency floor check covers listed security floors, but its toolchain fingerprint omission is reported as Finding 5. A separate vulnerability scan was not added because the task validation ceiling is `test-fast`.

## Tooling signals (Phase 0 and bounded checks)

- **Static inventory:** Current generated source trees are present; `git ls-files` reports no `dist/` declarations because `dist/` is ignored.
- **Barrel check:** Passed on the current checkout: all 286 generated React names were reachable.
- **Declaration check:** Passed on the current checkout: four React declaration files matched temporary TypeScript output.
- **Typecheck/lint:** `pnpm run test-fast` passed all 27 fast-tier steps, including workspace/library typecheck and lint.
- **Tests:** The existing route-drift unit suite and post-merge harness were inspected. No existing test covers shared-lock coordination, stale-lock replacement interleaving, generator dependency changes, `api-zod` declaration validation, or unexpected generated-file inventory.
- **Dependency audit:** No separate dependency vulnerability scan was run; the task explicitly caps validation at `pnpm run test-fast`. The repository’s `dependency:check` floor script was included in the inventory.

## Validation and report-only boundary

The requested command was run exactly:

```text
pnpm run test-fast
```

It passed all 27 steps.

No generated output, codegen configuration, or codegen tooling was changed. This task only adds this repository-tracked audit report. The findings are deferred recommendations; no fixes or regeneration were performed.

## Deferred / not audited

- API route business logic, authentication/authorization behavior, and database correctness beyond the specification/codegen boundary.
- Actual Orval regeneration and committing generated output, because regeneration is explicitly out of scope.
- Production deployment behavior and published package consumption outside the repository’s local package/build contract.
- React rendering-specific bug categories, because this audit covers the generator and validation boundary rather than a React component tree.