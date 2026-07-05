---
name: API server lazy AI client init
description: All AI integration libs must use lazy getters — module-level client construction crashes the server before port binds if env vars are absent.
---

# API server lazy AI client init

The rule: never construct an AI/integration client at module load time. Always use a cached lazy getter (`let _client = null; export function getClient() { if (!_client) { ...validate env... _client = new Client(...) } return _client; }`).

**Why:** The api-server's esbuild bundle imports all workspace packages. Any module-level `if (!process.env.KEY) throw` or `new Client(...)` executes the moment the route file is loaded — before the HTTP server binds its port. The result is a crash loop that looks like "port never opened".

**How to apply:** When adding a new integration lib that needs env vars:
1. Do NOT put `if (!process.env.KEY) throw` at the top level of any `.ts` file that gets imported at startup.
2. Do NOT do `export const client = new Client(...)` at module level.
3. DO add a `getXxxClient()` function with a module-level `let _client = null` cache. Throw inside the getter.
4. Watch for sub-modules (e.g. `image/client.ts`, `audio/client.ts`) that copy-paste the same eager pattern — fix those too, and have them import from the shared `../client` getter instead of duplicating it.

**Affected libs (already fixed):**
- `lib/integrations-poe-server/src/index.ts` → `getPoeClient()`
- `lib/integrations-gemini-ai/src/client.ts` → `getAiClient()` (also `image/client.ts`)
- `lib/integrations-openai-ai-server/src/client.ts` → `getOpenAIClient()` (also `image/client.ts`, `audio/client.ts`)
- `artifacts/api-server/src/lib/aiProvider.ts` → `getAiClient()` (the original fix)
