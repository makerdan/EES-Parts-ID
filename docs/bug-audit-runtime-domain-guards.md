# Runtime Domain Guards Bug Audit

**Scope:** Report-only audit of light-mode configuration, web bundle-domain
validation, client-to-server package reachability, production database target
preflight, and their validation-tier/configuration boundaries.

**Mode:** Report-only

**Date:** 2026-09-16

**Evidence boundary:** The audit used repository files, generated local bundle
files already present in the checkout, synthetic/static reasoning, and
side-effect-free local commands. It did not read secret values, connect to
production services, connect to a production database, mutate database data,
or change a guard, environment configuration, test, or generated artifact.

## Executive summary

The guards correctly reject the currently tested unsafe database modes, keep
the current Parts ID bundle free of `.replit.dev` occurrences, and enforce the
current light-mode defaults. The shared database boundary is fail-closed for
missing or invalid `DATABASE_ENV`, and API startup defers the database import
until production environment validation has run.

The audit verified four guard weaknesses:

1. The standalone bundle-domain check passes when there is no bundle, so a
   missing or empty build can look like a successful scan.
2. The light-mode shell scan silently excludes `.ts` files because of `find`
   operator precedence.
3. The light-mode default check is an unanchored text search rather than a
   check of the `DEFAULT_SETTINGS` object.
4. The production database target assertion confirms only the environment
   label; it does not establish database configuration or reachability. The
   command name and output make that target-only scope explicit.

The client reachability guard also has a documented coverage boundary: it
checks only `@workspace/parts-id`. The current browser-oriented
`@workspace/mockup-sandbox` has no server-only dependency and is treated as a
development-only artifact by the repository threat model, so this is recorded
as a coverage limitation rather than a current production leak.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 3 |

| # | Severity | Category | Location | One-line description |
|---|---|---|---|---|
| 1 | Medium | Fail-open / false readiness | `artifacts/parts-id/scripts/check-bundle-domain.js:10-32` | The standalone bundle check exits successfully when its build directory or JavaScript inputs are absent. |
| 2 | Low | Shell parsing / boundary coverage | `scripts/check-light-mode-config.sh:55-62` | `find` precedence means the raw `useColorScheme` scan selects `.tsx` files but not `.ts` files. |
| 3 | Low | False positive / assertion precision | `scripts/check-light-mode-config.sh:42-48` | Any matching `themeMode: "light"` text in `AppContext.tsx` can satisfy the default-setting check. |
| 4 | Medium | Environment ambiguity / false readiness | `artifacts/api-server/scripts/check-production-database.ts:10-27` | Production target assertion validates only `DATABASE_ENV=production`, not `DATABASE_URL` or database reachability. |
| 5 | Low | Coverage boundary / guard bypass | `scripts/check-db-reachability.mjs:41,261-273` | The graph traversal has one hardcoded client root, so newly added browser artifacts are outside this guard until registered. |

## Guard matrix

| Guard | Inputs | Trust boundary | Invocation context | Failure behavior |
|---|---|---|---|---|
| Light-mode configuration | `artifacts/parts-id/app.json`, `AppContext.tsx`, component/screen source under `components/` and `app/` | Repository source before the native/web app is built | `light-mode-config` in `test-fast` | Invalid JSON fails through `set -e`; missing/default mismatch increments errors and exits 1; raw imports are reported and exit 1. |
| Standalone bundle-domain check | Existing `artifacts/parts-id/static-build/web` files and JavaScript contents | Generated web output already on disk | `bundle-domain-check` in `test-fast`; also runnable from the Parts ID package | `.replit.dev` matches exit 1; missing/empty output currently exits 0; clean scan exits 0. |
| Build-time bundle-domain check | Resolved deployment domain and Expo web output | Parts ID production build process | `artifacts/parts-id/scripts/build.js` after the web export completes | Missing output, no JavaScript, missing expected domain, or any `.replit.dev` occurrence throws and fails the build. |
| Client reachability | Workspace globs, package manifests, local `workspace:`, `link:`, and `file:` edges | Static workspace dependency graph | `lint` step in `test-fast`; optional `--self-test` | Missing baseline package or configured root fails; reachable server-only target fails with a dependency chain; clean graph exits 0. |
| Production database target assertion | `DATABASE_ENV` only | Shared `@workspace/db/runtime-data-boundary` predicate before database import | API production build and `production-database-target` in `test-standard` | Missing/invalid/non-production target is caught and exits 1 without printing target or credential values; `production` exits 0 without opening a connection or claiming readiness. |
| API production startup | `NODE_ENV`, `DATABASE_ENV`, required environment variables, and later database import | API process startup | API `src/index.ts` | `validateEnv()` runs before the dynamic database import; missing production variables exit 1; the database module independently requires `DATABASE_URL` and matching execution mode. |

## Mode and configuration evaluation

### Development

- The API development script sets `NODE_ENV=development` but does not set
  `DATABASE_ENV`; the documented local command must supply
  `DATABASE_ENV=development`.
- The database module rejects an unset or mismatched target before creating a
  pool.
- Parts ID development uses `REPLIT_DEV_DOMAIN` when no internal deployment
  domain is available. The build script warns about this fallback and refuses
  it when `NODE_ENV=production`.
- `.replit` registers development workflows and ports but does not itself
  establish a production database target.

### Test

- The API test script defaults `DATABASE_ENV` to `test`.
- The validation runner scopes only the database-backed `test` step to
  `DATABASE_ENV=test` without mutating its parent process.
- The shared boundary treats `NODE_ENV=test` or `JEST_WORKER_ID` as a test
  application target and rejects production for test, seed, and schema-sync
  operations.
- No test command used in this audit contacted a production database.

### Production

- `artifacts/api-server/.replit-artifact/artifact.toml` sets both
  `NODE_ENV=production` and `DATABASE_ENV=production` for build and run.
- The API build script invokes the production-target preflight before its
  bundle build.
- API startup validates production environment names before dynamically
  importing `@workspace/db`; the database module then requires
  `DATABASE_URL` and a matching application execution mode.
- The production-target preflight itself does not test connectivity. That
  distinction is important: it is a target-safety guard, not a database
  health/readiness probe.

## Ten-category audit

| Category | Result |
|---|---|
| 1. Mode confusion | **Finding 4.** The production preflight checks the database label but does not assert `NODE_ENV` or database connectivity. The artifact configuration supplies the expected production values, and API startup has a separate mode check. |
| 2. Fail-open handling | **Finding 1.** The standalone bundle scanner treats missing or empty build output as a pass. The build-integrated scanner is stricter and fails in those cases. |
| 3. False readiness / stale inputs | **Findings 1 and 4.** A stale existing bundle can be scanned without proving it came from the current build; a production target can be confirmed without proving a usable database. |
| 4. Shell parsing | **Finding 2.** The `find` expression is not grouped, so the `.ts` branch has no `-print0` action and the loop receives only `.tsx` paths. |
| 5. Input/assertion precision | **Finding 3.** `grep` searches the whole context file for a token sequence rather than binding the value to `DEFAULT_SETTINGS`. |
| 6. Boundary coverage | **Finding 5.** Reachability has one explicitly configured client root. The current mockup sandbox is clean and dev-only, but a future browser artifact could be omitted. |
| 7. Secrets and logging | **Pass.** The production target error and preflight output do not echo the rejected target, database URL, or credentials. Existing production environment diagnostics log variable names and boolean readiness only. |
| 8. Timeouts and resource safety | **Pass for audited guards.** The guards perform local file/manifest operations and do not open network or database connections. The API integration tests use bounded child-process timeouts, but those are test harness behavior rather than preflight behavior. |
| 9. Package and implementation divergence | **Mixed.** The standalone bundle scanner is fail-open while the build-integrated scanner is fail-closed. The database boundary is shared by API startup and preflight, which avoids predicate drift. |
| 10. Invocation and tier registration | **Mixed.** Light mode, reachability, and standalone bundle checks run in `test-fast`; production target preflight runs in `test-standard`. The standalone bundle check is not coupled to a fresh build in either tier. |

## Findings

### Finding 1 — Standalone bundle-domain check passes without a bundle

- **File and line:** `artifacts/parts-id/scripts/check-bundle-domain.js:10-32`
- **Related implementation:** `artifacts/parts-id/scripts/build.js:860-913`
- **Category:** Fail-open / false readiness
- **Severity:** Medium
- **Classification:** Verified validation false positive; partially mitigated by the build-integrated guard.
- **Evidence:** The standalone script exits 0 when `static-build/web` does not exist and exits 0 again when the directory contains no `.js` files. The `bundle-domain-check` validation step invokes this script directly and does not build the web artifact first. The same package's build-integrated `verifyBundleDomain` instead throws when its JavaScript output directory is missing or empty. The current checkout happened to contain three JavaScript files, so the passing result was a real scan of those files, not evidence that a clean checkout would be scanned.
- **Risk:** A removed, failed, or stale web build can produce a green validation result while no domain invariant was checked. If a caller relies on the standalone validation step rather than the production build's stricter check, a preview-domain leak or missing API domain can reach a later stage undetected.
- **Recommended fix:** Make the standalone check fail when the scan root or JavaScript set is absent, or require it to consume a build manifest tied to the current build. Keep the build-integrated and standalone contracts aligned. This audit made no fix.

### Finding 2 — Light-mode source scan excludes `.ts` files

- **File and line:** `scripts/check-light-mode-config.sh:55-62`
- **Related implementation:** `scripts/check-light-mode-config.sh:51-53`
- **Category:** Shell parsing / boundary coverage
- **Severity:** Low
- **Classification:** Verified future bypass; no current violating `.ts` file was found.
- **Evidence:** The command is `find "$COMPONENTS_DIR" "$APP_DIR" -name "*.ts" -o -name "*.tsx" -print0`. Because `-a` has higher precedence than `-o`, the `.ts` branch has no print action and the effective output is `.tsx` matches only. The checkout contains 73 source files across the two roots: 2 `.ts` and 71 `.tsx`; the guard selects 71. A raw-import search found no current violating `.ts` file, so this is a guard coverage defect rather than a reproduced product defect.
- **Risk:** A future UI component or screen implemented as `.ts` can import `useColorScheme` directly from `react-native` and bypass the guard while the script reports all checks passed.
- **Recommended fix:** Group the predicates and attach `-print0` to the complete expression, then add a contract fixture for both extensions. This audit made no fix.

### Finding 3 — Light-mode default assertion is not anchored to `DEFAULT_SETTINGS`

- **File and line:** `scripts/check-light-mode-config.sh:42-48`
- **Related implementation:** `artifacts/parts-id/contexts/AppContext.tsx:91-98`
- **Category:** False positive / assertion precision
- **Severity:** Low
- **Classification:** Verified static false-positive opportunity; current default is correct.
- **Evidence:** The guard passes if any line in `AppContext.tsx` matches `themeMode:\s*"light"`. It does not parse or anchor the match to the `DEFAULT_SETTINGS` object. The current object does contain `themeMode: "light"` at line 94, and the current validation passes, but a later unrelated object, fixture, or comment could satisfy the grep after the default drifted.
- **Risk:** A configuration regression can be reported as healthy if another matching text string remains in the context file. This weakens the guard's claim that new or unset users start in light mode.
- **Recommended fix:** Use a narrowly scoped structural assertion or a focused contract test that evaluates the `DEFAULT_SETTINGS` initializer, while retaining the current readable failure message. This audit made no fix.

### Finding 4 — Production database target assertion confirms a label, not database readiness

- **File and line:** `artifacts/api-server/scripts/check-production-database.ts:10-27`
- **Related implementation/configuration:** `lib/db/src/runtimeDataBoundary.ts:63-91`; `artifacts/api-server/src/lib/validateEnv.ts:85-153`; `artifacts/api-server/.replit-artifact/artifact.toml:20-34`
- **Category:** Environment ambiguity / false readiness
- **Severity:** Medium
- **Classification:** Verified scope mismatch; not an unsafe production connection or data mutation.
- **Evidence:** The target assertion imports `assertProductionDatabaseTarget()` and checks only that `DATABASE_ENV` normalizes to `production`. It does not read `DATABASE_URL`, create a pool, or execute a connectivity probe. The production artifact configuration supplies the production label for build and run, while API startup later performs required-variable validation and only then imports the database module. A local invocation with `DATABASE_ENV=production` and no production database URL still exits 0 and states that URL and connectivity were not checked; no database operation occurs.
- **Risk boundary:** A missing URL or unreachable database is deferred to startup, and a network failure is not detected at build/validation time. This is intentional: the target assertion does not connect to production implicitly.
- **Resolution:** Preserve the target-only behavior under the `check:production-database-target` command and `production-database-target` validation label. Its success and failure messages state that `DATABASE_URL` and connectivity are not checked. Any future readiness probe must be a separately named, explicitly authorized operation with strict environment and timeout controls.

### Finding 5 — Database reachability has a single hardcoded client root

- **File and line:** `scripts/check-db-reachability.mjs:41,261-273`
- **Related context:** `pnpm-workspace.yaml:1-5`; `artifacts/mockup-sandbox/package.json`; `threat_model.md:7`
- **Category:** Coverage boundary / guard bypass
- **Severity:** Low
- **Classification:** Verified future coverage gap; no current server-only dependency was found in the omitted artifact.
- **Evidence:** `CLIENT_ROOTS` contains only `@workspace/parts-id`, and the main loop traverses only those configured names. The workspace also contains the browser-oriented `@workspace/mockup-sandbox`, which is therefore not checked by this guard. The current graph has no path from Parts ID to `@workspace/db` or any flagged server-only integration, and the mockup sandbox currently has no such dependency. The repository threat model treats the sandbox as development-only, which limits present production impact but does not make the root list self-updating.
- **Risk:** If another browser artifact becomes deployable or receives a shared package that reaches `@workspace/db` or a flagged server-only package, this guard can remain green because the artifact is not traversed.
- **Recommended fix:** Make the set of client roots an explicit validated inventory, or derive it from artifact metadata with a fail-closed review for newly added browser artifacts. Keep development-only artifacts documented as intentionally excluded rather than relying on omission. This audit made no fix.

## Verified safe behavior and non-findings

- **Database target parsing:** `getDatabaseEnvironment()` rejects unset, blank,
  and unknown values and normalizes surrounding whitespace/case. It does not
  silently default to development or production.
- **Application mode matching:** `assertDatabaseExecutionMode("application")`
  requires production `NODE_ENV` to use production `DATABASE_ENV`, test/Jest
  processes to use test, and all other application processes to use development.
- **Production import ordering:** API startup calls `validateEnv()` before the
  dynamic `@workspace/db` import. The database module separately requires
  `DATABASE_URL`, so the target check is not a database connection bypass.
- **Server-only graph baseline:** The current self-test covers direct,
  deep-chain, clean, and `serverOnly`-flag cases. The current repository scan
  found no forbidden target reachable from Parts ID.
- **Bundle-domain build path:** The Parts ID production build's internal
  `verifyBundleDomain()` fails closed for missing output, empty output, a
  missing expected domain, and `.replit.dev` occurrences. Finding 1 is about
  the separate standalone checker and its validation-tier invocation.
- **Logging safety:** The audited preflight failure path reports the required
  setting without echoing rejected environment values or credentials. No
  secret values were accessed for this audit.
- **No current light-mode violation:** `app.json` declares `userInterfaceStyle`
  as `light`, `DEFAULT_SETTINGS.themeMode` is `light`, and the current selected
  `.tsx` sources contain no prohibited raw `useColorScheme` import.

## Baseline and validation

The focused guard commands passed against the current checkout:

- `bash scripts/check-light-mode-config.sh`
- `pnpm --filter @workspace/parts-id run check:bundle-domain`
- `node scripts/check-db-reachability.mjs --self-test`
- `node scripts/check-db-reachability.mjs`
- Production preflight rejected unset, development, test, and staging
  `DATABASE_ENV` values without echoing them, and accepted only
  `DATABASE_ENV=production`.

The mandated validation command was run exactly:

- `pnpm run test-fast` — **passed, 27/27 steps**.

No failure retries were necessary. No standard, standard-plus, or heavy tier
was run.

## Report-only confirmation

This audit changed only this report. No guard implementation, environment
configuration, package manifest, validation tier, test, generated bundle,
database, production service, secret, or deployment setting was changed.