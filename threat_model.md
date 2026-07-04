# Threat Model

## Project Overview

Parts ID is a pnpm monorepo for an inventory lookup and warehouse-management system. The production application consists of an Express 5 API (`artifacts/api-server`) backed by PostgreSQL/Drizzle (`lib/db`) and an Expo client (`artifacts/parts-id`) that authenticates with Clerk and calls the API with bearer tokens. The server also integrates with third-party AI providers for part identification, enrichment, translation, and reference answers, and with object storage for uploaded images and floor-plan assets.

This scan assumes production deployment on Replit with TLS terminated by the platform and `NODE_ENV=production`. The design/mockup sandbox artifact is treated as dev-only unless a future scan demonstrates production reachability.

## Assets

- **User accounts and sessions** — Clerk identities, bearer tokens, approval status, and admin role state. Compromise would allow impersonation or unauthorized admin actions.
- **Inventory and warehouse data** — part records, descriptions, barcodes, bin locations, photos, dimensions, floor plans, and zone overlays. Integrity matters because staff decisions and warehouse navigation depend on this data.
- **Administrative controls** — approval/ban/promote/demote actions, AI provider switching, restart controls, upload pipelines, and analytics views. Abuse would let an attacker take over operations or degrade service.
- **Uploaded and generated content** — catalog PDFs, part photos, floor-plan SVGs, cached raster tiles, and AI-generated metadata. These cross file, image, and storage trust boundaries.
- **Administrator-consumed exports** — CSV/XLSX query exports and other generated files that may contain attacker-controlled text. These are a client execution boundary because spreadsheet software can treat cell content as active formulas.
- **Application secrets and external-service authority** — database credentials, Clerk keys, AI provider keys, and object-storage credentials. Leakage would enable direct abuse of backend resources or third-party spend.
- **Contact and analytics data** — support/contact submissions, admin ask logs, and event-tracking payloads. These may contain operationally sensitive or user-submitted text.

## Trust Boundaries

- **Client / API boundary** — all mobile and web requests cross from an untrusted client into `artifacts/api-server/src/app.ts`. Every request body, header, URL param, and upload payload must be treated as attacker-controlled.
- **Authenticated / unauthenticated boundary** — `requireAppAuth` protects `/api/*` except the explicit public allowlist in `artifacts/api-server/src/middlewares/requireAppAuth.ts` (`/healthz` and `/inventory/estimate-dimensions/search`). Any route intended to be public must be deliberately whitelisted; all others must require a valid Clerk session and approved user status.
- **User / admin boundary** — `requireAdminAuth` and downstream `res.locals.appUser.role` checks separate normal users from admin-only mutation and operational endpoints.
- **API / database boundary** — the Express server has broad database authority via Drizzle and occasional raw SQL. Injection or authorization mistakes at the API layer can expose or modify all inventory and user data.
- **API / object storage and filesystem boundary** — uploaded photos, floor-plan SVGs, PDF chunks, and cached tiles are written to object storage or temporary disk; path handling, content validation, and lifecycle management matter here.
- **Stored content / browser-client boundary** — uploaded rich content that is later rendered in the web app, especially SVG, must be treated as untrusted markup rather than inert media.
- **API / external AI boundary** — the server sends user-controlled prompts, images, and documents to OpenAI/Poe/Gemini-adjacent providers. Outbound requests must not leak secrets, and expensive endpoints need abuse controls.
- **Internal / production boundary** — seed scripts, tests, local diagnostics, and the mockup sandbox preview surface are out of production scope unless explicitly wired into deployed request paths.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/**/*.ts`, `artifacts/parts-id/app/_layout.tsx`.
- **Auth and approval boundary:** `artifacts/api-server/src/middlewares/requireAppAuth.ts`, `artifacts/api-server/src/middlewares/requireAdminAuth.ts`, `artifacts/api-server/src/routes/admin.ts`.
- **Highest-risk server areas:** `inventory.ts`, `catalogPdf.ts`, `adminUpload.ts`, `adminQuery.ts`, `ai.ts`, `reference.ts`, `floorPlan.ts`, `lib/objectStorage.ts`.
- **Public surfaces:** `/api/healthz`, `/api/inventory/estimate-dimensions/search`, selected read/search/reference endpoints that are only app-authenticated rather than admin-only.
- **Dev-only areas to usually ignore:** `artifacts/mockup-sandbox` preview routes, tests, seed scripts, `.agents/`, and other local tooling unless production reachability is proven.

## Threat Categories

### Spoofing

The API trusts Clerk-issued bearer tokens and then maps them to local approval and role state. The system must validate the Clerk session on every protected request, must not accept client-asserted role or approval claims, and must ensure admin-only operations rely on server-side role checks rather than frontend state.

### Tampering

Normal users and admins can submit inventory edits, uploads, floor-plan data, contact messages, analytics events, and AI prompts. The system must validate all request bodies and route params server-side, must calculate or enforce sensitive state transitions on the server, and must prevent attackers from modifying records, storage objects, or long-running jobs outside their intended authority. Uploaded SVG and other rich content must also be sanitized before any web rendering path treats them as DOM markup.

### Information Disclosure

The application stores warehouse inventory, internal floor plans, approval status, user lists, contact submissions, and AI-generated content. API responses, logs, and storage object paths must not expose data beyond the caller’s authorization level, and public or broadly authenticated endpoints must not become a shortcut to internal admin or warehouse-sensitive data.

### Denial of Service

The API accepts large JSON payloads, images, SVGs, and PDFs and can trigger expensive AI and document-processing work. Public or broadly accessible endpoints must have meaningful pre-parse size limits, concurrency controls, and rate limits so attackers cannot exhaust CPU, memory, storage, or AI spending. Admin-only heavy jobs still need queueing or per-admin caps because compromised admin accounts remain in scope.

### Elevation of Privilege

Admin actions include user approval, promotion, restart, upload, floor-plan mutation, and query-style endpoints with broad database visibility. The system must enforce admin authorization server-side for every privileged route, scope all non-admin reads to intended data sets, and prevent injection, path traversal, or unsafe file handling from turning user input into arbitrary backend capability.
