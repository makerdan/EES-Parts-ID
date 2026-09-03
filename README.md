# Workspace

## Overview

pnpm workspace monorepo using TypeScript. **Parts ID** — Expo (React Native) electrical parts identification and warehouse inventory lookup tool.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM (pg_trgm, unaccent extensions enabled)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Mobile**: Expo Router v6 + React Native Web (web preview)
- **AI**: OpenAI gpt-5.1 (photo ID), gpt-5-mini (enrichment) via Replit AI Integrations proxy

## Artifacts

### parts-id (Expo mobile app)
- Password-only login (server-side: APP_PASSWORD secret validates via POST /api/auth/app-login and returns a signed session token; password never ships in the JS bundle)
- **Google OAuth redirect URL**: set `EXPO_PUBLIC_APP_URL` to the canonical production origin (e.g. `https://your-app.replit.app`). The web OAuth callback is built from this value so the redirect URL is predictable. In Clerk Dashboard → Paths → "Allowed redirect URLs" add `https://your-app.replit.app/sso-callback`. Without this entry Google rejects the redirect and the user sees a blank page. Omit the env var in local dev — it falls back to `window.location.origin`.
- 3 tabs: Search, Photo ID, Upload/Inventory
- Dark industrial amber theme (primary: #f59e0b, dark bg: #0d1117)
- Fuse.js offline fuzzy search fallback
- AI photo identification via OpenAI vision
- Per-item manual keyword editing UI
- Floating Reference modal with electrical abbreviations/slang

### api-server (Express API)
Routes:
- `POST /api/inventory/search` — semantic search with Fuse.js fallback
- `GET /api/inventory` — list all inventory
- `POST /api/inventory/batch` — upsert batch (no wipe)
- `POST /api/inventory/enrich` — AI batch keyword enrichment (SSE)
- `PATCH /api/inventory/:id/enrich` — force re-enrich a single part with fresh AI keywords (admin)
- `PATCH /api/inventory/:id/keywords` — per-item keyword edit
- `POST /api/ai/identify` — OpenAI photo identification
- `GET /api/ai/reference` — SSE reference stream
- `GET /api/dictionaries/*` — abbreviations, vendors, synonyms, misspellings, slang

### DB Schema
Tables: `inventory`, `abbreviation_map`, `vendor_map`, `synonym_map`, `misspelling_map`, `electrical_slang_map`

### Seed Data
210 abbreviations, 66 vendors, 177 synonyms, 283 misspellings, 144 slang entries
Seed: `node --import tsx/esm --no-warnings src/seed/run.ts` from `artifacts/api-server/`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm run doctor` — run `expo doctor` against parts-id; catches SDK version drift before it reaches the bundler
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Expo SDK version drift

`expo doctor` is wired into the **expo-doctor** validation step and the `pnpm run doctor` root script. Run it (or trigger the validation) any time you bump an Expo-related dependency to confirm every package stays on the versions Expo SDK 54 expects. Drift causes Metro resolution errors at runtime — catching it here surfaces a clear, actionable message instead.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Validation tier conventions

Every task plan must declare exactly one validation tier. This prevents all four tiers from firing simultaneously during task validation and makes the validation screen readable.

### Tier names and coverage

| Tier | Runner command | What it covers | Typical duration |
|---|---|---|---|
| `fast` | `test-fast` | Static checks: scoped Failure/Regression Guards, `tsc`, lint, config, port, and bundle-domain checks | ~5 min |
| `standard` | `test-standard` | fast + codegen/spec/env checks, Failure Gate contract coverage, and tests | ~20 min |
| `standard-plus` | `test-standard-plus` | standard + `schema-check`, `verify-fts`, `api-server-coverage`, `security-audit`, `post-merge-health-test` | ~30 min |
| `heavy` | `test-heavy` | Same as standard-plus (currently identical steps) | ~30 min |

**Picking a tier (defaults unless the plan clearly implies otherwise):**
- `fast` — pure config or refactor with no logic change
- `standard` — most feature/bug-fix work; tasks touching only tests, mocks, or doc changes
- `standard-plus` — DB schema, auth, or API contract changes
- `heavy` — reserved for future use; currently same as standard-plus

### Plan file format

Every task plan markdown file must include a `## Validation tier` section with exactly one of the four tier names on the next non-blank line:

```markdown
## Validation tier
standard
```

Before creating a task, run both plan guards with the task file scoped:

```bash
TASK_PLAN_FILE=.local/tasks/my-plan.md node scripts/check-failure-gate.mjs
TASK_PLAN_FILE=.local/tasks/my-plan.md node scripts/check-regression-guard.mjs
bash scripts/check-plan-tier.sh .local/tasks/my-plan.md
```

The script exits 0 if the tier is valid, 1 with a clear error otherwise.

### Agent completion convention

When a task agent finishes work:

1. **`fast`-tier tasks**: The Project gate (`test-fast`) runs automatically on merge. No manual `startValidationRun` call is needed — pass `skip_validation_reason` to `markTaskComplete` citing that the gate covers it.
2. **Heavier tiers (`standard`, `standard-plus`, `heavy`)**: Call `startValidationRun({ commandIds: ["test-standard"] })` (or the appropriate tier command) before marking complete. Then pass `skip_validation_reason` to `markTaskComplete` with the run ID, e.g. `"Ran test-standard (run-abc123); gate covers fast tier on merge."`.

### `gate-guard` check

`gate-guard` (`scripts/check-gate-integrity.sh`) is the first step in every tier. It fails immediately if the Project CI gate contains anything other than `test-fast`. If it fails:

1. Check `.replit` — the `[[workflows.workflow]]` block named `"Project"` must have exactly one `[[workflows.workflow.tasks]]` entry: `task = "workflow.run"` / `args = "test-fast"`.
2. Remove any extra entries and re-run.

## Agent rules

### Failure Gate (always active)

Every Planner and Build agent must follow the Failure Gate skill at
`.agents/skills/failure-gate/SKILL.md`. The full decision tree, section
templates, and lint-guard documentation live there. The summary below is the
session-mandate checklist that must be satisfied before any plan is written.

#### Scaffolding helper

When creating a plan, use `node scripts/new-plan.mjs <slug> --why "<real reason>" --tier <tier>`. `scripts/new-task-plan.mjs` remains a compatible alias. The scaffold writes the required baseline, validation, legacy tier, and Regression Guard sections, then runs a task-scoped repair pass.

#### HARD-GATE checklist (Planner — complete before writing any plan)

1. **Memory and catalog scan** — Open `.agents/memory/MEMORY.md` and
   `docs/validation/failure-baseline.json`; check for exact suite, test, and
   signature matches. Only authoritative, unexpired `active` records may be
   referenced.
2. **Ownership** — Every referenced baseline must use exactly one
   `**Ignored baseline:**` or `**Owned baseline repair:**` declaration. A
   retry pass proves intermittency only, never pre-existing provenance.
3. **Known-pattern scan** — Check memory for known-flaky
   entries touching suites or files this task modifies.
   Known categories: `reverseVendorMap row-order flake`, `vendor-map
   heap-order tests`, `concurrent effects consume fetchWithAuth mocks out of
   order`, `jest.clearAllMocks clears ALL mock implementations`.

4. **Recent task scan** — Search recently merged task descriptions for
   "pre-existing", "known failure", "flaky", or suite names this task touches.

5. **Spot-run** — If the task touches `artifacts/api-server` code, run the
   api-server test suite once before any changes and record failures as
   pre-existing. Skip otherwise (expensive; benefit only applies to server
   code).

6. **Write `## Pre-existing failures to ignore`** — Place after "Steps",
   before "Relevant files". Mandatory even when empty.

7. **Write `## Validation`** — Immediately after the pre-existing section.
   Must contain all three lines:
   - `**Command:**` — one of `test-fast`, `test-standard`,
     `test-standard-plus`, `test-heavy`
   - `**Why:**` — non-placeholder justification
   - `**Do not escalate:**` — non-placeholder text

#### Required Planner announcement line

Before writing the first heading of any plan, emit this exact line:

```
[FAILURE-GATE] Discovery checklist complete. Pre-existing failures documented: <N>. Validation command: `<command>`.
```

#### Build agent ceiling rule

Set `TASK_PLAN_FILE` for every task validation. The `## Validation` command is
the exact locked tier and ceiling: a missing, unreadable, malformed, or
mismatched plan fails before any validation step. Run
`node scripts/run-locked-tier.mjs .local/tasks/<plan>.md`, or invoke the named
registered command with `TASK_PLAN_FILE` set. Never use `--allow-no-plan` for a
task. That flag is reserved for explicit ad-hoc/non-task validation.

Ordinary task validation scopes `--fix-stub` and strict checks to the one plan;
it never scans or rewrites the ignored `.local/tasks/` archive. Archive review
is an explicit maintenance operation using `--archive`. Temporary observations
do not authorize ignores. Baseline lifecycle rules are in
`docs/validation/failure-baseline.md`; the opt-in report is
`pnpm run maintain:validation-baseline`.

Task validation is locked to the plan. Platform completion validation is a
separate final gate and may run broader registered commands; do not skip that
completion check merely because it is broader than the task tier.

---

## Checks: validation commands (formerly workflows)

Only the three long-running services are ordinary workflows: `artifacts/api-server: API Server`, `artifacts/parts-id: expo`, and `artifacts/mockup-sandbox: Component Preview Server`. The `Project` workflow is the single merge-gate entrypoint and runs `test-fast`. Every one-off check is a **registered validation command** (run via validation runs; these do not consume workflow slots). Do not recreate the removed one-shot workflow declarations.

### Validation tiers (consolidated runners)

Four tier commands run subsets sequentially via `scripts/run-tier.mjs`, with membership centralized in `scripts/validation-steps.mjs`, and are wrapped in the named-resource `scripts/serial-lock.mjs` (`validation`, `codegen`, `shared-test-results`, and `ports`). Task calls require `TASK_PLAN_FILE`; explicit ad-hoc calls must opt in with `--allow-no-plan`. Tiers are cumulative. Lock budgets begin after acquisition, and stale/dead-holder recovery is always logged.

- **`test-fast`** — static checks only: `gate-guard`, task-scoped Failure Gate and Regression Guard repair/check steps, `tsc`, lint, config, port, and bundle-domain checks. (~5 min)
- **`test-standard`** — fast + codegen/spec/env checks, `failure-gate-contract`, and tests. (~20 min)
- **`test-standard-plus`** — standard + `schema-check`, `verify-fts`, `api-server-coverage`, `security-audit`, `post-merge-health-test`. Full quality signal without Playwright browser automation. (~30 min)
- **`test-heavy`** — standard-plus (same steps, no Playwright currently). For schema migrations, new API routes, auth/security changes, multi-package refactors. (~30 min)

The table below keeps historical check names discoverable for targeted runs;
they are validation steps, not standalone workflows. Tier membership lives in
`scripts/validation-steps.mjs` and is executed by `scripts/run-tier.mjs` — keep
it in sync with this table when checks change. Note: `tsc` subsumes
`typecheck`, `typecheck-libs`, `canvas-typecheck`, `api-server-typecheck`, and
`parts-id-typecheck`, so tiers run only `tsc`.

| Old workflow name | Validation command | Tier |
|---|---|---|
| _(new)_ | `gate-guard` | fast (first step in every tier) |
| _(new)_ | `plan-gate-fix` | fast (auto-remediate; always exits 0) |
| _(new)_ | `plan-gate-check` | fast (strict Failure Gate lint) |
| _(new)_ | `plan-gate-stubs` | fast (stub-placeholder warning count; always exits 0) |
| _(new)_ | `regression-guard-fix` / `regression-guard` | fast (task-scoped declaration repair then strict check) |
| _(new)_ | `failure-gate-contract` | standard (focused integration contract) |
| `api-server-coverage` | `api-server-coverage` | standard-plus / heavy |
| `api-server-typecheck` | `api-server-typecheck` | fast (via `tsc`) |
| `bundle:domain-check` | `bundle-domain-check` | fast |
| `canvas-typecheck` | `canvas-typecheck` | fast (via `tsc`) |
| `codegen:check` | `codegen-check` | standard |
| `env:check` | `env-check` | standard |
| `lint` | `lint` | fast |
| `lint:mocks` | `lint-mocks` | fast |
| `parts-id-typecheck` | `parts-id-typecheck` | fast (via `tsc`) |
| `port-guard` | `port-guard` (one-shot scan, not a watcher) | fast |
| `post-merge-health-test` | `post-merge-health-test` | standard-plus / heavy |

| `schema:check` | `schema-check` | standard-plus / heavy |
| `security-audit` | `security-audit` | standard-plus / heavy |
| `spec:check` | `spec-check` | standard |
| `spec:check:tests` | `spec-check-tests` | standard |
| `test` | `test` | standard |
| `tsc` | `tsc` | fast |
| `tsconfig:check` | `tsconfig-check` | fast |
| `typecheck` | `typecheck` | fast (via `tsc`) |
| `typecheck:libs` | `typecheck-libs` | fast (via `tsc`) |
| `verify-fts` | `verify-fts` | standard-plus / heavy |

### Port Authority contract

Development ports are declared once in `scripts/dev-ports.json`. Its workflow,
fallback, legacy, and cleanup sets are checked against the three service
workflow `waitForPort` values in `.replit` by `scripts/dev-port-contract.mjs`.
Run `bash scripts/check-hardcoded-ports.sh` before changing a service startup
command. `scripts/free-dev-ports.mjs` sweeps only those explicitly registered
ports, sequentially, and refuses to report success while a protected holder is
still bound. It never scans or kills unregistered ports.

The port cleaner protects the caller's process tree, terminates only socket
owners discovered through `/proc`, escalates from SIGTERM to SIGKILL with
diagnostics, and confirms each port is free. Production/deployment paths do not
invoke the development sweep. No app-owned live-update WebSocket endpoint was
found during the runtime audit, so no speculative application heartbeat was
added; the preview's own HMR transport remains under the dev-server supervisor.

## Admin MFA Enforcement

Admin endpoints enforce multi-factor authentication **by default**. Any admin session that lacks a completed second factor (`totp`, `phone_code`, or hardware key) in the Clerk `amr` session claim receives:

```
403 { error: "MFA required for admin access", code: "MFA_REQUIRED" }
```

**Disabling (not recommended):** Set `SKIP_ADMIN_MFA=true` in the API server environment (Replit Secrets → api-server). The server emits a startup warning whenever this flag is set. Do not set it in production deployments.

> **Migration from the old opt-in flag:** If your deployment previously set `ENFORCE_ADMIN_MFA=true`, you can safely remove that variable — MFA is now on by default and that variable is no longer read.

**Admin enrollment:** Admins enable two-factor authentication through the Clerk account portal (Settings → Security → Two-step verification). The mobile app surfaces an Alert with a button to open the portal when MFA is required.

Relevant file: `artifacts/api-server/src/middlewares/requireAdminAuth.ts`

## shadcn/ui update runbook

The Canvas artifact (`artifacts/mockup-sandbox`) uses shadcn/ui scaffold files in `src/components/ui/`. These files are auto-generated and are **not** audited automatically when `shadcn add` is run or when a dependency (e.g. `recharts`, `input-otp`) is bumped.

**After any `shadcn add` or package bump that touches a shadcn dependency:**

1. Run `pnpm --filter mockup-sandbox run typecheck` and confirm it exits 0.
2. Fix any type errors before committing — scaffold files frequently use APIs that shift between package versions (e.g. recharts chart prop types, input-otp slot render props).

The workspace `tsc` validation step covers the Canvas package automatically in
the `test-fast` command used by the Project gate. Running the package check
locally before committing avoids a failed merge gate.

## User preferences

- **Tasks must never silently wait for user input.** If a task agent (or any
  agent) determines it needs information from the user mid-task, it must post
  the explicit question in the user-visible chat (e.g. via `user_query` or a
  plain main-chat message) before parking the task in an awaiting-input state.
  Do not pause on an internal-only prompt that the user cannot see — the user
  should always know exactly what is being asked of them and why.
- Terse, plain-language responses. No emojis, no flattery. Say what was done
  or what is blocked.
- Theme-aware colors in mobile UI; respect dark amber industrial theme.
