# Bug & Error Audit Report — Workspace JavaScript

**Scope:** First-party JavaScript-family source in workspace `scripts/` and shared `lib/`: CLI/runtime helpers, validation and lock orchestration, API-spec codegen helpers, account-skill projection, and the shared PCM playback worklet. **Mode:** report-only. **Date:** 2026-09-24. **Stack:** Node.js 24 ESM/CommonJS, pnpm, filesystem and process locks, Orval, browser AudioWorklet. No application TypeScript or React component tree was audited.

## Inventory, method, and prior work

The inventory found **67** non-generated, non-`dist`, non-`node_modules` JS-family files: 59 under `scripts/` (27 named test/contract files) and eight under `lib/` (including configuration files). Inspected implementation and relevant callers/contracts:

| Surface | Files inspected or traced | Boundary |
|---|---|---|
| CLI and validation | `scripts/validation-steps.mjs`, `run-tier.mjs`, `serial-lock.mjs`, `serial-lock-critical.mjs`, `lib/tier-lock-check.mjs`, `lib/failure-baseline.mjs`, `publish-test-result.mjs`, `test-result-artifact.mjs`, `check-browser-bundles.mjs`, `check-dead-exports.mjs`, `refresh-ci-validation-parity-report.mjs` and relevant `scripts/test/validation-runtime-contract.test.mjs` | Process exit, child ownership, input and evidence parsing, tier membership, command dispatch, cleanup |
| Account skills | `scripts/account-skills-sync.mjs`, `account-skill-status.mjs`, `lib/account-skill-projection.mjs`, `test/skill-mirror-sync-contract.test.mjs` | Source fingerprints, lock/recovery, mirror status and file integrity |
| Generated contracts | `lib/api-spec/post-codegen.mjs`, `scripts/ensure-codegen.mjs`, `scripts/run-codegen.mjs`, `scripts/generated-output-check.mjs`, `scripts/check-generated-output.mjs`, relevant `src/__tests__/ensure-codegen.test.ts` | Shared codegen lock, marker inputs, inventory and barrel checks |
| Audio | `lib/integrations-openai-ai-react/src/audio/audio-playback-worklet.js`; adjacent typed `useAudioPlayback.ts`, `audio-utils.ts`, `useVoiceStream.ts` inspected only to establish the message protocol | Buffer, playback completion, stop/clear, output channels |

Other enumerated JS contract suites, release/port/map/database commands, and JS-family package configuration were inventoried, not exhaustively re-audited. Prior reports `docs/bug-audit-validation-runtime-controls.md`, `bug-audit-api-codegen-validation.md`, `bug-audit-static-validation-tooling.md`, `bug-audit-service-smoke-contracts.md`, `bug-audit-package-runtime-validation.md`, and `bug-audit-build-process.md` were compared for overlap. In particular, old claims about direct-child-only serial-lock termination, live max-hold reclaim, independent codegen locks, and an input hash omitting resolved Orval are **not current findings**: current code uses process groups, refuses live max-hold reclaim, shares the `codegen` resource, and includes a resolved dependency graph. This report does not repeat the existing mirror contract *test-process timeout* finding or the build-process environment finding.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |

| # | Severity | Category | File:line | Verified outcome |
|---:|---|---|---|---|
| 1 | Medium | State & data integrity / security | `scripts/lib/account-skill-projection.mjs:173-210` | Mirror status returns `pass` even when the mirror's actual skill is absent or different from the canonical skill. |
| 2 | Low | State & data integrity | `lib/integrations-openai-ai-react/src/audio/audio-playback-worklet.js:79-88` | `stop` leaves queued samples in place, so the next audio message replays the stopped stream first. |
| 3 | Low | Type boundary / output integrity | `lib/integrations-openai-ai-react/src/audio/audio-playback-worklet.js:92-106` | Only the first output channel is written; a second channel retains its previous contents. |

## Verified findings

### 1. Mirror status accepts metadata without checking mirror contents

- **File and line:** `scripts/lib/account-skill-projection.mjs:173-210`; exposed through `scripts/account-skill-status.mjs:15-36`.
- **Category:** State & data integrity / security. **Severity:** Medium.
- **Evidence:** The status helper hashes the *canonical* source, then compares it only against fields read from the mirror's metadata JSON. It checks that the mirror root is a directory and metadata a regular file, but never reads, enumerates, or hashes the mirrored skill files. In an isolated temporary source/mirror fixture, a metadata file with matching canonical fingerprint returned `pass` with **no mirrored `SKILL.md`**; adding a different `SKILL.md` still returned `pass`. No workspace mirror was touched. The existing contract also creates metadata without skill files and expects `pass` (`scripts/test/skill-mirror-sync-contract.test.mjs:215-239`), confirming the current behavior.
- **Risk:** Operators or automation relying on `account-skill:status` may treat an incomplete, modified, or stale disposable mirror as usable and invoke different instructions than the published source. This does not prove that the canonical projection itself is corrupt; its separate validation hashes projection contents.
- **Minimal recommended fix:** Enumerate and hash actual mirror skill files against the canonical file list/fingerprint before reporting `pass`; reject missing, unexpected, symlinked, or modified entries. Add a temp-directory contract for matching metadata with missing or changed content.

### 2. `stop` preserves old audio samples

- **File and line:** `lib/integrations-openai-ai-react/src/audio/audio-playback-worklet.js:79-88,96-104`.
- **Category:** State & data integrity. **Severity:** Low.
- **Evidence:** `clear` calls `ringBuffer.clear()` but `stop` only changes flags. An isolated worklet-VM fixture queued two samples, consumed one, sent `stop`, then queued a new sample: the next output was `[0.75, 0.125]`, the *old* remaining sample followed by the new sample. The bundled typed hook currently sends `clear`, not `stop`; this is a verified defect in the reusable worklet's exposed message protocol, not a claim that the current hook triggers it.
- **Risk:** A consumer using `stop` to cancel speech can hear leftover audio when a subsequent stream starts.
- **Minimal recommended fix:** Clear the ring buffer on `stop`, or explicitly define and enforce pause/resume semantics under a different message type; add a stop → new audio fixture.

### 3. Multichannel outputs are not fully initialized

- **File and line:** `lib/integrations-openai-ai-react/src/audio/audio-playback-worklet.js:92-106`.
- **Category:** Type boundary / output integrity. **Severity:** Low.
- **Evidence:** `process()` selects `output[0]` and never accesses later channels. In an isolated fixture with two output channels prefilled with `9`, after an audio message the first became `[0.5, 0.25]` and the second remained `[9, 9]`. The fixture proves the worklet's handling of a multichannel output array; it does not establish that the currently constructed `AudioWorkletNode` actually negotiates two channels in all browsers.
- **Risk:** A multichannel consumer can hear stale or inconsistent audio on channels other than the first, instead of duplicated mono samples or silence.
- **Minimal recommended fix:** Explicitly configure a mono output if mono is the contract, or copy the rendered mono frame (including silence) to every provided channel; test two-channel output.

## Ten-category dispositions

| Category | Disposition |
|---|---|
| Null / undefined safety | Reviewed parsed lock/manifest metadata and worklet output guards. Malformed audio messages (`event.data`, `samples`) are a candidate, but the current typed sender supplies both; no additional defect verified. |
| Async & timing | Reviewed lock acquire/heartbeat/termination, codegen ensure/recheck, and mirror operations; no new timing finding. Prior validation-runtime audit has its own historical findings. |
| Error handling | Reviewed subprocess status propagation, fail-fast tiers, codegen output errors, and projection rollback. No new independent error-propagation issue verified. |
| Type safety / boundary assumptions | Finding 3; JS worklet output shape is provided by the audio engine. React-specific rendering checks are inapplicable. |
| State & data integrity | Findings 1 and 2; codegen marker and generated-output manifest are separately guarded in current code. |
| Security | Finding 1 affects trust in a disposable mirror; not a verified remote compromise or source-projection corruption. No additional command-injection or credential disclosure established in this scope. |
| Performance | Inspected ring growth and lock polling; unbounded buffering during prolonged producer/consumer imbalance is a candidate, not promoted without a realistic traffic bound or memory reproduction. |
| Concurrency & shared state | Reviewed codegen lock sharing and serialized validation/skill-projection ownership; no newly verified interleaving defect. |
| Dead / unreachable code | Inspected worklet message branches and package-level checks; no verified unreachable path. |
| Dependency hygiene | Reviewed package declarations, generator lockfile fingerprint, and registered dependency contracts; no new package defect established. A full vulnerability audit is not part of the mandated standard tier. |

## Tooling signals and validation

The isolated mirror fixture used temporary filesystem roots and removed them; the audio fixture used an in-memory Node VM with mocked worklet registration. Neither invoked codegen or external services. `docs/validation/failure-baseline.json` has no records; the plan grants no known-failure waiver. The registered **`test-standard`** command includes library and scripts typecheck, library lint, contract tests and dependency-security contracts, but not the `pnpm audit` vulnerability step (registered only in `standard-plus`). The root library lint command uses `eslint lib/ --ext .ts`, so the `.js` worklet is not directly linted by that command. Record the observed completion run and any blocked steps below; do not infer a bug from a failed command alone.

**Observed completion run:** `test-standard` (validation run `YHJiF0ei9mQY6IihnkAkA`) **FAILED with exit 124** after its configured 420,000 ms post-lock budget. It had passed the prior steps through `static-validation-boundaries` and was in `port-authority-contract` when the wrapper terminated its process group; the tier emitted no final report and did **not** reach the standard-only codegen, specification, test, or other standard-extra steps. This is a time-budget/unfinished-run signal, not a verified source defect or a passed standard tier. No heavier tier was invoked.

- **Typecheck:** `tsc` and `api-spec-typecheck` finished without errors in this run; generated clients were already current on the typecheck fast path.
- **Lint:** The `lint` step finished with one Parts ID React-hook warning (no errors). The library dead-export runner printed a Knip `vite.config.ts` missing-`PORT` diagnostic while continuing and returning success; that diagnostic alone does not establish a library defect. `lint-mocks`, `validation-parser-tests`, `tsconfig-check`, and `static-validation-boundaries` also completed.
- **Tests/contracts:** Fast-prefix contracts through `static-validation-boundaries`, including the account-skill mirror contract and dependency-security contract, completed. `port-authority-contract` was interrupted, not classified as failed assertions; remaining contract steps and workspace `pnpm test` did not run. No test failed that could be retried under the flaky-test rule.
- **Dependency audit:** `dependency-security-contract`, `parts-id-dependency-contract`, and `patched-dependencies` completed. `pnpm audit --audit-level=low` is registered in `standard-plus`, not the requested standard tier, and was not run. No claim is made that dependencies are free of vulnerabilities.

## Deferred / report-only boundary

No production implementation, tests, package settings, generated output, service data, or live service was intentionally changed by this audit. No fix tasks are authorized by the report. Full TypeScript-only shared libraries, API routes, Parts ID screens, Canvas, artifact-local JavaScript, build processes, package runtime and validation-test suites are deferred to their own scopes. The three findings above are recommendations pending user choice.