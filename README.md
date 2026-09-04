# EES Parts ID

Electrical parts identification and warehouse inventory lookup tool — a full-stack pnpm monorepo built with Expo (React Native) and Express.

## What it does

- **Barcode / photo scan** — snap a photo of an electrical part and get an AI-powered identification with manufacturer, part number, and description
- **Fuzzy search** — search the parts inventory by keyword, part number, or description (PostgreSQL full-text search with Fuse.js offline fallback)
- **Inventory management** — upload CSV batches, AI-enrich keywords, and edit per-item keywords in the app
- **Warehouse map** — interactive floor-plan with zone overlay and anchor-point calibration
- **Admin panel** — Clerk role-based access for inventory management, enrichment, and map calibration

## Stack

| Layer | Technology |
|---|---|
| Mobile app | Expo (React Native Web + native), Expo Router v6 |
| API | Express 5, TypeScript, tsx |
| Database | PostgreSQL + Drizzle ORM (`pg_trgm`, `unaccent`) |
| Validation | Zod v4, `drizzle-zod` |
| API codegen | Orval (OpenAPI → typed hooks) |
| Auth | Clerk (role-based: `admin` / user) |
| AI | OpenAI gpt-5.1 vision (photo ID), gpt-5-mini (keyword enrichment) via Replit AI Integrations proxy |
| Monorepo | pnpm workspaces |

## Project structure

```
artifacts/
  parts-id/       # Expo mobile app
  api-server/     # Express REST API
  mockup-sandbox/ # Vite component preview server (dev)
lib/
  db/             # Drizzle schema + migrations
  api-spec/       # OpenAPI spec
  api-zod/        # Generated Zod validators
  api-client-react/ # Generated React Query hooks
scripts/          # CI helpers, codegen, port guards
data/
  public/            # intentionally public warehouse layout reference data
```

## Getting started

### Prerequisites

- Node.js 24
- pnpm 10
- PostgreSQL (connection string in `DATABASE_URL` secret)

### Install

```bash
pnpm install
```

### Environment secrets

Set server-only values in the Replit Secrets pane. Do not put them in `.env`
files, mobile code, or client build configuration.

| Server value | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_ENV` | Explicit database target: `development`, `test`, or `production` |
| `SESSION_SECRET` | Express session signing key |
| `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Clerk authentication |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | OpenAI via Replit proxy |
| `POE_API_KEY2` | Poe AI fallback |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Replit Object Storage bucket used by server uploads |

Only explicitly public `EXPO_PUBLIC_*` values belong in the client build:
`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, API origins, the Clerk proxy URL, and
public tool domains. Never expose `DATABASE_URL`, `CLERK_SECRET_KEY`, AI keys,
or object-storage configuration to the mobile/web bundle.

Inventory imports must read a source file supplied outside the repository:

```bash
DATABASE_ENV=development DATABASE_URL="$DATABASE_URL" pnpm --filter @workspace/api-server exec tsx \
  src/seed/import-spreadsheet.ts /path/to/inventory.xlsx
```

Seed and import commands refuse `DATABASE_ENV=production`. Use a separate
development or test Replit PostgreSQL database and set `DATABASE_ENV` explicitly
before running them. Schema synchronization follows the same rule:

```bash
DATABASE_ENV=development pnpm --filter @workspace/db run push
```

The deployed API uses `DATABASE_ENV=production` and Replit-hosted PostgreSQL.
There is no embedded database or database export workflow. Do not commit
inventory exports, uploaded documents, database backups, or operational logs.
See [public repository readiness](docs/public-repository-readiness.md) for the
public/private data boundary and the deterministic repository check.

### Run (development)

```bash
# API server (port from $PORT env)
pnpm --filter @workspace/api-server run dev

# Expo app (port from $PORT env)
pnpm --filter @workspace/parts-id run dev
```

### Run checks

```bash
pnpm run typecheck:libs          # TypeScript across all libs
pnpm --filter @workspace/parts-id run lint
pnpm --filter @workspace/api-server run lint
pnpm test                        # Full test suite
```

## License

MIT — see [LICENSE](LICENSE).
