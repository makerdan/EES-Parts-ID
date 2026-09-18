---
name: tsx + Node.js v24 ESM extension resolution
description: tsx@4.21.0 on Node.js v24 no longer auto-resolves bare .ts names in ESM packages; explicit .ts extensions required.
---

**Rule:** In `"type": "module"` packages that are consumed directly as TypeScript source via tsx, all internal imports must use explicit file extensions (`.ts` for files, `/index.ts` for directories).

**Why:** tsx@4.21.0 running on Node.js v24 stopped implicitly appending `.ts` to bare specifiers in ESM packages. Imports like `./generated/api` that previously resolved to `./generated/api.ts` now throw `ERR_MODULE_NOT_FOUND`. This surfaced in `lib/api-zod/src/index.ts` after Node.js bumped to v24.13.0.

**How to apply:** Any workspace package with `"type": "module"` that is imported directly from TypeScript source (not compiled first) should use explicit `.ts` extensions:
- `./generated/api` → `./generated/api.ts`
- `./generated/types` (directory) → `./generated/types/index.ts`
- `./adminProfile` → `./adminProfile.ts`

This applies to `lib/api-zod` and any similar "source-first" shared lib in the monorepo.
