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
- Password-only login (EXPO_PUBLIC_APP_PASSWORD env var, default: "warehouse2024")
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
