---
name: Poe Bot API Protocol
description: Correct Poe API endpoint, key, model naming, and client setup for calling Poe bots from the server.
---

# Poe Bot API Protocol

## The rule
Poe has an **OpenAI-compatible** endpoint at `https://api.poe.com/v1`. Use the OpenAI SDK with `baseURL: "https://api.poe.com/v1"` and `apiKey: process.env.POE_API_KEY2`.

**Why:** The legacy `https://api.poe.com/bot/` path uses Poe's own SSE protocol (for bot *servers*, not callers). The `/bot/` URL appended to the OpenAI SDK's `/chat/completions` always 404'd. The correct Creator-tier caller endpoint is `/v1/chat/completions`.

## Key: POE_API_KEY2 (not POE_API_KEY)
`POE_API_KEY` is an old key tied to an account without bot-calling permissions. `POE_API_KEY2` is the Creator-tier key that works. Both `poeBot.ts` and `aiProvider.ts` must use `POE_API_KEY2`.

## Model naming
Poe model names are **PascalCase display names** with version dots, e.g.:
- `"Claude-Haiku-4.5"` — fast/cheap, confirmed working
- `"Claude-Sonnet-4.5"` — capable, confirmed working
- `"GPT-4o-Mini"` — confirmed working
- `"GPT-4o"` — confirmed working

**Not** lowercase slugs like `"gpt-4o-mini"` or `"gpt-5-mini"` (those return empty/error).

Models NOT on this account (return empty): `gpt-5-mini`, `GPT-5-Mini`, `Claude-Haiku-4.5` (use `Claude-Haiku-4.5` spelling above).

## Current bot constants (aiProvider.ts)
- `POE_ENRICH_BOT = "GPT-5-Mini"` — keyword enrichment & description expansion (fast, confirmed working)
- `POE_IDENTIFY_BOT = "Claude-Sonnet-4.5"` — part identification, catalog PDF extraction
- `POE_DIMENSIONS_BOT = "Claude-Sonnet-4.5"` — dimension estimation from photos

## callPoeBot() in poeBot.ts
Uses OpenAI SDK lazy-init client at `/v1`. Signature: `callPoeBot(botName, systemInstruction, userMessage): Promise<string>`. Exports `isPoeCallAuthError`, `isPoeCallTransientError` using OpenAI SDK error types.

## How to apply
- Always use `callPoeBot()` from `poeBot.ts` for direct Poe calls — NOT `getAiClient()` from `aiProvider.ts` (the shared client is for the provider-agnostic path).
- Expand Descriptions (`/expand-descriptions` route in `inventory.ts`) and Bulk Enrichment (`generateKeywords.ts`) both call `callPoeBot` directly with `POE_ENRICH_BOT`.
- Startup probe in `aiProvider.ts` uses `_client` (now correctly pointed at `/v1` with `POE_API_KEY2`) and probes all three bot names on startup — all three should log `OK`.
- Models endpoint: `GET https://api.poe.com/v1/models` — no auth required; returns full catalog.
