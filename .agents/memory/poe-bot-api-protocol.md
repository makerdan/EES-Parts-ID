---
name: Poe Bot API Protocol
description: How Poe's server bot API actually works, and why the existing OpenAI-SDK approach never worked.
---

# Poe Bot API Protocol

## The rule
`https://api.poe.com/bot/{bot_name}` uses Poe's **own SSE protocol**, NOT OpenAI's chat completions API. The OpenAI SDK with `baseURL: "https://api.poe.com/bot/"` always appends `/chat/completions` → 404.

**Why:** The existing `aiProvider.ts` / `integrations-poe-server` used OpenAI SDK with that base URL. Every AI call via Poe was silently returning 404. The server started fine (key presence check only), but all Poe bot calls failed.

## Correct raw protocol
- URL: `POST https://api.poe.com/bot/{bot_name}` (no `/chat/completions` suffix)
- Auth: `Authorization: Bearer {api_key}`
- Body (Poe query format):
  ```json
  {
    "version": "1.0",
    "type": "query",
    "query": [{ "role": "user", "content": "...", "content_type": "text/markdown", "timestamp": <microseconds>, "message_id": "<uuid>", "attachments": [] }],
    "user_id": "...",
    "conversation_id": "...",
    "message_id": "<same as query[0].message_id>"
  }
  ```
- Response: SSE stream with `event: text / data: {"text": "..."}` and `event: done / data: {}`.

## What `allow_retry: true` means
HTTP 200 + `event: error` + `allow_retry: true` = transient server error OR account-level permission issue. If ALL bots (including free "Assistant") return this, the POE_API_KEY doesn't have bot-calling permissions or is tied to a disabled account.

## Bot naming rule
Poe bot names are **all lowercase, no spaces, and case-sensitive**. Mixed-case names (e.g. `"GPT-4o"`, `"GPT-5-mini"`) cause HTTP 404 from the Poe API even when the protocol and key are correct.

Correct examples:
- `"gpt-4o-mini"` (not `"GPT-4o-mini"`)
- `"gpt-4o"` (not `"GPT-4o"`)
- `"gpt-5-mini"` (not `"GPT-5-mini"`)
- `"gpt-5.1"` (not `"GPT-5.1"`)

**Why:** Poe's routing is exact-match on the bot name slug; uppercase letters produce a 404.

## How to apply
- If rewiring Poe: implement raw `fetch` SSE parsing, do NOT use OpenAI SDK for Poe bot calls.
- Always use lowercase bot names in `aiProvider.ts` Poe branches and any `ENRICH_MODEL`-style fallbacks.
- The implemented `callPoeBot()` in `artifacts/api-server/src/lib/webSearch.ts` has the correct raw fetch implementation.
- The project pivoted to Replit's Gemini integration (`@workspace/integrations-gemini-ai` / `gemini-2.5-flash`) when Poe key was non-functional.
