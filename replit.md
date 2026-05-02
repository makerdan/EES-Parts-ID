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
Tables: `inventory`, `abbreviation_map`, `vendor_map`, `synonym_map`, `misspelling_map`, `electrical_slang_map`, `category_node` (3-level taxonomy: category→subcategory→type), `inventory_category` (item↔node mapping with confidence + source).

### Browse-by-Category (Task #100)
- 6 endpoints under `/api/categories`: `tree`, `:slug/items`, `uncategorized`, `coverage`, `:nodeId/assign` (admin), `classify` (admin SSE).
- Hybrid classifier: rule pass (`utils/taxonomyClassifier.ts`, ~60 rules over catalog/desc/aiKeywords) + AI fallback (`utils/aiClassify.ts`, gpt-4o-mini, default ON). Rule-misses go to AI; AI-misses fall through to the `Uncategorized` leaf.
- Slug uniqueness: `category_node.slug` is **globally unique** (DB constraint). Slugs are assigned by the seed/admin layer with prefixes (e.g. `breaker-gfci`, `wire-thhn`) so a single slug always resolves to one node — `/categories/{slug}/items` never needs disambiguation.
- Seed taxonomy: 10 categories, 14 subcategories, 59 types (`seed/taxonomy.ts`, idempotent by slug).
- Coverage after run: 6223 / 7399 items (84%) — all by `rule` source.
- Mobile UI: Search/Browse segmented toggle in `app/(tabs)/index.tsx`; `components/BrowseTaxonomy.tsx` drills 3 levels with AsyncStorage persistence (`parts_id_browse_tree_v1`, `parts_id_browse_path_v1`, `parts_id_browse_mode_v1`); pure helpers extracted to `lib/taxonomy.ts`.

### Seed Data
210 abbreviations, 66 vendors, 177 synonyms, 283 misspellings, 144 slang entries
Seed: `node --import tsx/esm --no-warnings src/seed/run.ts` from `artifacts/api-server/`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
