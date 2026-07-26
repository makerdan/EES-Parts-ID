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

| Secret | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Express session signing key |
| `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Clerk authentication |
| `APP_PASSWORD` | App-level password gate |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | OpenAI via Replit proxy |
| `POE_API_KEY2` | Poe AI fallback |

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
