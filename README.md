# EES Parts ID

Expo (React Native) mobile app and Express API for electrical parts identification, semantic search, and warehouse inventory management.

## Overview

EES Parts ID is a **pnpm workspace monorepo** built in TypeScript that provides an Expo mobile app and a Node/Express API for identifying electrical parts, managing inventory, and searching by technical terms, abbreviations, and slang.  
It is designed for electrical warehouses, technicians, and admin staff who need fast photo-based identification and robust text search over a curated parts dictionary.

## Features

- **Expo mobile app (`parts-id`)**
  - Password-only login backed by the API (`POST /api/auth/app-login`) using a server-side `APP_PASSWORD` secret; the password never ships in the JS bundle.
  - Google OAuth support via Clerk, with a predictable redirect URL derived from `EXPO_PUBLIC_APP_URL`.
  - Three primary tabs:
    - **Search** — semantic search over inventory with Fuse.js offline fuzzy fallback.
    - **Photo ID** — AI photo identification using OpenAI vision models.
    - **Upload / Inventory** — batch upload and inventory management workflows.
  - Dark industrial **amber theme** (primary `#f59e0b`, dark background `#0d1117`) with theme-aware UI.
  - Per-item **manual keyword editing** UI to refine searchability.
  - Floating **Reference modal** with electrical abbreviations and slang.

- **Express API (`api-server`)**
  - `POST /api/inventory/search` — semantic inventory search with Fuse.js fallback.
  - `GET /api/inventory` — list all inventory items.
  - `POST /api/inventory/batch` — batch upsert inventory without wiping existing data.
  - `POST /api/inventory/enrich` — AI batch keyword enrichment via Server-Sent Events (SSE).
  - `PATCH /api/inventory/:id/enrich` — force re-enrichment for a single part (admin-only).
  - `PATCH /api/inventory/:id/keywords` — edit keywords for a single part.
  - `POST /api/ai/identify` — OpenAI photo identification endpoint.
  - `GET /api/ai/reference` — streamed electrical reference content via SSE.
  - `GET /api/dictionaries/*` — access abbreviations, vendors, synonyms, misspellings, and slang dictionaries.

- **Database & Dictionaries**
  - PostgreSQL schema with specialized tables for:
    - `inventory`
    - `abbreviation_map`
    - `vendor_map`
    - `synonym_map`
    - `misspelling_map`
    - `electrical_slang_map`
  - Seed data for rich search:
    - 210 abbreviations
    - 66 vendors
    - 177 synonyms
    - 283 misspellings
    - 144 slang entries

- **AI Integration**
  - OpenAI **gpt-5.1** for photo-based identification.
  - OpenAI **gpt-5-mini** for keyword enrichment.
  - Accessed via Replit AI Integrations proxy.

- **Robust validation & CI**
  - Tiered validation commands (`test-fast`, `test-standard`, `test-standard-plus`, `test-heavy`) for static checks, codegen, tests, schema verification, and security audits.
  - Serialized validation runs via a lock to prevent conflicting CI operations.

- **Security**
  - Admin MFA enforced by default for privileged API endpoints using Clerk session claims.
  - Optional override via `SKIP_ADMIN_MFA=true` (not recommended, emits a startup warning).
  - Clear 403 error response when MFA is required but not completed.

## Tech Stack

- **Language:** TypeScript 5.9
- **Monorepo & Package Manager:** pnpm workspaces, pnpm
- **Runtime:** Node.js 24
- **Backend Framework:** Express 5 (CJS bundle via esbuild)
- **Database:** PostgreSQL with Drizzle ORM  
  - Extensions: `pg_trgm`, `unaccent`
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Mobile:** Expo Router v6, React Native, React Native Web (web preview)
- **Build:** esbuild (CommonJS)
- **AI:** OpenAI gpt-5.1 and gpt-5-mini via Replit AI Integrations proxy
- **Search:** Fuse.js for fuzzy search (offline fallback)

## Getting Started

> Note: This project is a pnpm workspace monorepo. All commands below assume you are running them from the repository root.

### Install

1. Ensure you have:
   - **Node.js 24** installed.
   - **pnpm** installed.
2. Install dependencies:

   ```bash
   pnpm install
   ```

### Core Commands

- Type-check all packages:

  ```bash
  pnpm run typecheck
  ```

- Type-check and build all packages:

  ```bash
  pnpm run build
  ```

- Run Expo doctor for the mobile app (checks SDK version drift):

  ```bash
  pnpm run doctor
  ```

- Regenerate API hooks and Zod schemas from the OpenAPI spec:

  ```bash
  pnpm --filter @workspace/api-spec run codegen
  ```

- Push DB schema changes (development only):

  ```bash
  pnpm --filter @workspace/db run push
  ```

- Run the API server locally:

  ```bash
  pnpm --filter @workspace/api-server run dev
  ```

### Seeding the Database

From the `artifacts/api-server/` directory, run:

```bash
node --import tsx/esm --no-warnings src/seed/run.ts
```

This loads the seed data for abbreviations, vendors, synonyms, misspellings, and slang into the corresponding tables.

### Expo SDK Version Drift

The project wires `expo doctor` into:

- The **`expo-doctor`** validation step.
- The root `pnpm run doctor` script.

Run one of these whenever you bump an Expo-related dependency to confirm all packages stay aligned with **Expo SDK 54**. Misaligned versions cause Metro resolution errors at runtime; catching drift here yields clear, actionable errors.

## Project Structure

High-level artifacts:

- **`artifacts/parts-id`** — Expo mobile app
  - Password-only login backed by `/api/auth/app-login`.
  - Three main tabs: Search, Photo ID, Upload/Inventory.
  - Dark industrial amber theme and reference modal.

- **`artifacts/api-server`** — Express API server
  - Inventory, AI, and dictionary routes.
  - Seed script: `src/seed/run.ts`.
  - Admin MFA middleware: `src/middlewares/requireAdminAuth.ts`.

- **`artifacts/mockup-sandbox`** — Canvas component preview server
  - Uses `shadcn/ui` scaffold files in `src/components/ui/`.
  - Subject to `canvas-typecheck` validation.

- **`@workspace/api-spec`** (package name)
  - OpenAPI spec and Orval codegen configuration for API hooks and Zod schemas.

- **`@workspace/db`** (package name)
  - Drizzle ORM schema and DB-related scripts (including schema push).

Additional scripts and checks:

- **Validation tiers:** `scripts/run-tier.mjs` (defines `FAST`, `STANDARD_EXTRA`, `STANDARD_PLUS_EXTRA`, `HEAVY_EXTRA`).
- **Gate integrity:** `scripts/check-gate-integrity.sh` (`gate-guard`).
- **Plan tier linter:** `scripts/check-plan-tier.sh` for task plans.

## Deployment

### Google OAuth Redirect (Expo Web)

For production web builds:

- Set `EXPO_PUBLIC_APP_URL` to the canonical production origin, e.g.:

  ```env
  EXPO_PUBLIC_APP_URL=https://your-app.replit.app
  ```

- In the Clerk Dashboard → Paths → **Allowed redirect URLs**, add:

  ```
  https://your-app.replit.app/sso-callback
  ```

Without this entry, Google rejects the OAuth redirect and the user will see a blank page. For local development, omit `EXPO_PUBLIC_APP_URL` and the app falls back to `window.location.origin`.

### Admin MFA Enforcement

Admin endpoints enforce MFA by default:

- Any admin session without a second factor (`totp`, `phone_code`, or hardware key) in the Clerk `amr` claim receives:

  ```json
  403 { "error": "MFA required for admin access", "code": "MFA_REQUIRED" }
  ```

- To temporarily disable (not recommended, never in production), set:

  ```env
  SKIP_ADMIN_MFA=true
  ```

  The server logs a startup warning whenever this flag is present.

Previous opt-in flag `ENFORCE_ADMIN_MFA` is obsolete and can be removed.

Admin enrollment flow:

- Admins enable two-factor authentication via the Clerk account portal (Settings → Security → Two-step verification).
- The mobile app surfaces an alert with a link to open the portal when MFA is required.

## Contributing / Conventions

### Validation Tiers

Every task plan must declare **exactly one** validation tier. This keeps validation runs clear and prevents all tiers from firing simultaneously.

Supported tiers:

| Tier            | Command             | Coverage                                                                                           | Typical duration |
|-----------------|---------------------|----------------------------------------------------------------------------------------------------|------------------|
| `fast`          | `test-fast`         | Static checks only: `gate-guard`, `tsc`, `lint`, `lint-mocks`, `tsconfig-check`, `port-guard`, `bundle-domain-check` | ~5 min           |
| `standard`      | `test-standard`     | `fast` + `codegen-check`, `spec-check`, `env-check`, `spec-check-tests`, `test`                   | ~20 min          |
| `standard-plus` | `test-standard-plus`| `standard` + `schema-check`, `verify-fts`, `api-server-coverage`, `security-audit`, `post-merge-health-test` | ~30 min          |
| `heavy`         | `test-heavy`        | Same as `standard-plus` (reserved for future additional checks)                                   | ~30 min          |

**Defaults when planning work:**

- Use **`fast`** for pure config or refactor tasks with no logic change.
- Use **`standard`** for most feature and bug-fix work, including changes limited to tests, mocks, or docs.
- Use **`standard-plus`** for DB schema, auth, or API contract changes.
- Use **`heavy`** for future high-load scenarios; currently identical to `standard-plus`.

### Plan File Format

Task plan markdown files must include a `## Validation tier` section with exactly one tier name on the next non-blank line:

```markdown
## Validation tier
standard
```

Before calling `bulkCreateProjectTasks`, validate the plan:

```bash
bash scripts/check-plan-tier.sh .local/tasks/my-plan.md
```

- Exit code `0`: tier is valid.
- Exit code `1`: tier invalid, with a clear error message.

### Agent Completion Convention

When a task agent finishes:

1. **`fast`-tier tasks**
   - The Project gate (`test-fast`) runs automatically on merge.
   - Do **not** call `startValidationRun`.
   - Pass `skip_validation_reason` to `markTaskComplete` explaining that the gate covers the checks.

2. **Heavier tiers (`standard`, `standard-plus`, `heavy`)**
   - Call `startValidationRun({ commandIds: ["test-standard"] })` or the appropriate tier command.
   - Before marking complete, pass `skip_validation_reason` to `markTaskComplete` including the run ID, e.g.:

     > `Ran test-standard (run-abc123); gate covers fast tier on merge.`

### Gate Integrity (`gate-guard`)

`gate-guard` (`scripts/check-gate-integrity.sh`) is the first step in every tier. It fails if the Project CI gate runs anything other than `test-fast`.

If `gate-guard` fails:

1. Open `.replit`.
2. The `[[workflows.workflow]]` block named `"Project"` must have **exactly one** `[[workflows.workflow.tasks]]` entry:

   - `task = "workflow.run"`
   - `args = "test-fast"`

3. Remove any extra entries and re-run the validation.

### Validation Commands

Individual commands remain available for targeted runs, even though tiers orchestrate them:

- Fast-tier checks: `gate-guard`, `tsc`, `lint`, `lint-mocks`, `tsconfig-check`, `port-guard`, `bundle-domain-check`.
- Standard extras: `codegen-check`, `spec-check`, `env-check`, `spec-check-tests`, `test`.
- Standard-plus / heavy extras: `schema-check`, `verify-fts`, `api-server-coverage`, `security-audit`, `post-merge-health-test`.

`tsc` subsumes `typecheck`, `typecheck-libs`, `canvas-typecheck`, `api-server-typecheck`, and `parts-id-typecheck`, so tiers only run `tsc`.

Tier membership is defined in `scripts/run-tier.mjs` (`FAST`, `STANDARD_EXTRA`, `STANDARD_PLUS_EXTRA`, `HEAVY_EXTRA`). Keep this file in sync with the validation table whenever checks change.

### shadcn/ui Update Runbook (Canvas / Mockup Sandbox)

The Canvas artifact (`artifacts/mockup-sandbox`) uses auto-generated `shadcn/ui` components in `src/components/ui/`. These are **not** automatically audited when you:

- Run `shadcn add`.
- Bump dependencies like `recharts` or `input-otp`.

After any such change:

1. Run:

   ```bash
   pnpm --filter mockup-sandbox run typecheck
   ```

2. Fix any type errors before committing, as scaffold files often rely on APIs that shift between versions.

The `canvas-typecheck` validation step enforces this on every merge. Running it locally before committing avoids a failed merge gate.

### User Interaction Preferences

- Tasks must **never silently wait for user input**.
- If an agent needs information mid-task, it must:
  - Post an explicit question in the user-visible chat (e.g., via `user_query` or a main chat message).
  - Park the task in an awaiting-input state only after the question is visible.
- Do not pause on internal-only prompts; users should always know exactly what is being asked and why.

### UI & Theme Conventions

- Respect the **dark amber industrial theme** across mobile UI:
  - Primary color: `#f59e0b`.
  - Dark background: `#0d1117`.
- Use theme-aware colors and avoid introducing non-cohesive palettes.


---

**References:**

[1] **replit.md**
 <https://docs.replit.com/features/project-setup/replit-dot-md>

[2] **Setting up a Design System**
 <https://docs.replit.com/teams/custom-design-system>

[3] **The starting point for learning TypeScript**
 <https://www.typescriptlang.org/docs/>

[4] **Replit 프롬프트 생성기 | Skills Marketplace - LobeHub**
 <https://lobehub.com/ko/skills/sergio-bershadsky-ai-replit-prompt>

[5] **llms.txt - Replit**
 <https://replit.com/llms.txt>

[6] **Replit**
 <https://github.com/replit>

[7] **Build with Agent**
 <https://docs.replit.com/learn/build-with-agent>

[8] **Replit Guides**
 <https://replit.com/guides>

[9] **Replit | Awesome System Prompts**
 <https://elifuzz.github.io/awesome-system-prompts/replit>

[10] **olznra/system-prompts-and-models-of-ai-tools**
 <https://github.com/olznra/system-prompts-and-models-of-ai-tools>

[11] **Overview**
 <https://generaltranslation.com/en-GB/docs/core>

[12] **x1xhlol/system-prompts-and-models-of-ai-tools - GitHub**
 <https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools>

[13] **typescript-eslint/utils**
 <https://typescript-eslint.io/packages/utils/>

[14] **Replit Development Principles (For PMs)**
 <https://www.linkedin.com/pulse/replit-development-principles-pms-nathan-turnquist-xbdtc>

[15] **API Docs**
 <https://replit.com/blog/api-docs>

[16] **TypeScript Best Practices - W3Schools**
 <https://www.w3schools.com/typescript/typescript_best_practices.php>

[17] **GitHub - ts-essentials/ts-essentials: All essential TypeScript types in one place 🤙**
 <https://ithub.global.ssl.fastly.net/ts-essentials/ts-essentials>

[18] **Google TypeScript Style Guide**
 <https://google.github.io/styleguide/tsguide.html>

[19] **Understanding TypeScript utility types**
 <https://www.convex.dev/typescript/advanced/utility-types-mapped-types/typescript-utility-types>

[20] **Replit agent keeps deleting core parts of the code when ...**
 <https://www.reddit.com/r/replit/comments/1ffi757/replit_agent_keeps_deleting_core_parts_of_the/>

[21] **TypeScript Utility Types - W3Schools**
 <https://www.w3schools.com/typescript/typescript_utility_types.php>

[22] **TSConfig Reference - Docs on every TSConfig option**
 <https://www.typescriptlang.org/tsconfig/>

[23] **Replit's CEO apologizes after its AI agent wiped ...**
 <https://news.ycombinator.com/item?id=44646151>

[24] **TypeScript: type JavaScript and kill runtime bugs**
 <https://www.kern-it.be/en/definitions/typescript/>

[25] **Sustainable Electrical & Electronic System for the Automotive ...**
 <https://cordis.europa.eu/project/id/506075/reporting>

[26] **Replit Agent Prompts - Ready-to-Use Templates**
 <https://replstack.com/replit-prompts>

[27] **Essential Utilities & Helper Functions for TypeScript Projects**
 <https://www.youtube.com/watch?v=bWLeNhFaGRg>

[28] **Digital registration of entry and exits into the Schengen ...**
 <https://rangun.diplo.de/mm-en/2735594-2735594>

[29] **How To Edit Code In Replit | Quick And Easy (Updated 2026)**
 <https://www.youtube.com/watch?v=9l0CtjwY_IQ&vl=de>

[30] **TypeScript | IntelliJ IDEA Documentation**
 <https://www.jetbrains.com/help/idea/typescript-support.html>

[31] **TypeScript: Documentation - Advanced Types**
 <https://www.typescriptlang.org/docs/handbook/advanced-types.html>

[32] **Article - Replit FAQ**
 <https://bucknell.teamdynamix.com/TDClient/40/IT/KB/ArticleDet?ID=529>

[33] **TypeScript Cheatsheet, Common Errors, and More**
 <https://docs.joshuatz.com/cheatsheets/typescript/>

[34] **Replit's AI Agent Wipes Company's Codebase During ...**
 <https://gizmodo.com/replits-ai-agent-wipes-companys-codebase-during-vibecoding-session-2000633176>

[35] **The Best TypeScript Utility Library!**
 <https://www.youtube.com/watch?v=uPA2TO-GnnU>

[36] **Replit — Replit Blog – Product updates from the team**
 <https://replit.com/blog/category/eng/2>

[37] **typescript · GitHub Topics**
 <https://github.com/topics/typescript>

[38] **Replit CEO apologizes after AI engine says it 'made ...**
 <https://www.tomshardware.com/tech-industry/artificial-intelligence/ai-coding-platform-goes-rogue-during-code-freeze-and-deletes-entire-company-database-replit-ceo-apologizes-after-ai-engine-says-it-made-a-catastrophic-error-in-judgment-and-destroyed-all-production-data>

[39] **Should I upgrade my project to use ES modules instead of ...**
 <https://www.reddit.com/r/node/comments/1r23oh4/should_i_upgrade_my_project_to_use_es_modules/>

[40] **Azure Functions Node.js developer reference**
 <https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node>