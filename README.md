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
| `fast` | `test-fast` | Static checks only: `gate-guard`, `tsc`, `lint`, `lint-mocks`, `tsconfig-check`, `port-guard`, `bundle-domain-check` | ~5 min |
| `standard` | `test-standard` | fast + `codegen-check`, `spec-check`, `env-check`, `spec-check-tests`, `test` | ~20 min |
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

Before calling `bulkCreateProjectTasks`, run the plan linter:

```bash
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

## Checks: validation commands (formerly workflows)

Only long-running services are ordinary workflows: `artifacts/api-server: API Server`, `artifacts/parts-id: expo`, `artifacts/mockup-sandbox: Component Preview Server`. Every one-off check is a **registered validation command** (run via validation runs; these do not consume workflow slots). Names with colons were renamed to dashes; all commands are unchanged.

### Validation tiers (consolidated runners)

Four tier commands run subsets of the checks below sequentially via `scripts/run-tier.mjs`, wrapped in `node scripts/serial-lock.mjs --` so tier runs (and any check that internally takes the same lock, like `test`) **cannot race each other** — concurrent invocations queue and run one at a time. Per-step timing starts after lock acquisition, so queue-wait time never counts against a step. Tiers are cumulative: standard includes fast, standard-plus includes standard, heavy includes standard-plus.

- **`test-fast`** — static checks only: `gate-guard`, `tsc`, `lint`, `lint-mocks`, `tsconfig-check`, `port-guard`, `bundle-domain-check`. For pure UI/copy changes. (~5 min)
- **`test-standard`** — fast + `codegen-check`, `spec-check`, `env-check`, `spec-check-tests`, `test`. For most feature/bug-fix work. (~20 min)
- **`test-standard-plus`** — standard + `schema-check`, `verify-fts`, `api-server-coverage`, `security-audit`, `post-merge-health-test`. Full quality signal without Playwright browser automation. (~30 min)
- **`test-heavy`** — standard-plus (same steps, no Playwright currently). For schema migrations, new API routes, auth/security changes, multi-package refactors. (~30 min)

Individual check commands remain registered for targeted runs. Tier membership lives in `scripts/run-tier.mjs` (`FAST` / `STANDARD_EXTRA` / `STANDARD_PLUS_EXTRA` / `HEAVY_EXTRA`) — keep it in sync with this table when checks change. Note: `tsc` subsumes `typecheck`, `typecheck-libs`, `canvas-typecheck`, `api-server-typecheck`, and `parts-id-typecheck`, so tiers run only `tsc`.

| Old workflow name | Validation command | Tier |
|---|---|---|
| _(new)_ | `gate-guard` | fast (first step in every tier) |
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

The `canvas-typecheck` validation step enforces this automatically on every merge (it is wired into the Project CI gate). Running it locally before committing avoids a failed merge gate.

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
