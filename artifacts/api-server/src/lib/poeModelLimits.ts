/**
 * Image attachment limits reference for every AI model used by this app.
 *
 * ─── HOW TO READ THIS FILE ───────────────────────────────────────────────────
 *
 * Each section covers one model (or model group) with:
 *   • Human-readable notes explaining the limits and their source
 *   • Exportable numeric constants that code can import for enforcement
 *
 * Limit enforcement layers:
 *   "poe_relay"  — Poe's api.poe.com/v1 relay layer (undocumented; inferred)
 *   "provider"   — Published limit from the underlying model's native API
 *   "app"        — Limit enforced by this application before sending
 *
 * ─── IMPORTANT: POE RELAY LAYER ──────────────────────────────────────────────
 *
 * The app calls Poe via the OpenAI-compatible endpoint at https://api.poe.com/v1.
 * Poe acts as a thin relay: it forwards the request to the underlying model
 * provider and proxies the response back.
 *
 * Poe's developer docs (creator.poe.com) do NOT publish per-image or per-request
 * size limits for the OpenAI-compatible caller API.  The only image-related
 * Poe-level limit documented is for *server bots* using `enable_image_comprehension`
 * (1 image per message via Poe's own vision pre-processing) — that path is not
 * used here; images are sent inline as base64 data: URIs in the content array,
 * which the relay forwards to the underlying provider without Poe-level
 * transformation.
 *
 * Therefore, the effective limits when calling Poe bots with inline images are
 * the underlying model provider's limits, applied at the provider layer.
 * Poe may impose its own undocumented caps; we treat them as ≤ provider limits.
 *
 * Source: https://creator.poe.com/docs/server-bots/enabling-file-upload-for-your-bot
 *         https://creator.poe.com/docs/server-bots/poe-protocol-specification
 */

// ── Claude Sonnet 4.5 (Poe bots: POE_IDENTIFY_BOT, POE_DIMENSIONS_BOT) ───────
//
// Underlying provider: Anthropic
//
// Published limits (Anthropic API direct — source: platform.claude.com/docs/en/build-with-claude/vision):
//   • Max image file size:     10 MB per image (base64-encoded)
//   • Max images per request:  100 (for 200 k-token context models, e.g. Sonnet 4.5)
//                              600 (for all other Claude models)
//   • Max image dimensions:    8 000 × 8 000 px per image
//   • Stricter dimension cap:  When a single request contains >20 images, each image
//                              must be ≤ 2 000 px on each side; otherwise rejected
//                              with `invalid_request_error` ("many-image requests").
//   • Total request size:      32 MB (Anthropic direct API);
//                              ~20–30 MB via partner platforms (Bedrock = 20 MB,
//                              Vertex = 30 MB) — Poe relay unknown, treat as ≤ 32 MB.
//   • Enforcement layer:       "provider" (Anthropic API; Poe relay likely passes through)
//
// Note: Claude Sonnet 4.5 is confirmed as a 200k-token context model, so the
// 100-image-per-request limit applies.

/** Max base64-decoded byte size per image for Claude Sonnet requests (Anthropic limit). */
export const MAX_IMAGE_BYTES_CLAUDE_SONNET = 10 * 1024 * 1024; // 10 MB

/** Max number of images per request for Claude Sonnet 4.5 (200k-token context). */
export const MAX_IMAGES_PER_REQUEST_CLAUDE_SONNET = 100;

/** Max image dimension (width or height) for Claude Sonnet. */
export const MAX_IMAGE_DIMENSION_CLAUDE_SONNET = 8000; // px

/**
 * When a request has more than this many images, Claude imposes a stricter
 * per-image dimension cap of 2 000 × 2 000 px.
 */
export const CLAUDE_MANY_IMAGE_THRESHOLD = 20;

/** Stricter per-image dimension limit when request exceeds CLAUDE_MANY_IMAGE_THRESHOLD. */
export const MAX_IMAGE_DIMENSION_CLAUDE_MANY = 2000; // px

/** Anthropic API total request size limit (32 MB); treat as upper bound for Poe relay too. */
export const MAX_REQUEST_BYTES_CLAUDE_SONNET = 32 * 1024 * 1024; // 32 MB

// ── Gemini-3.1-Pro (Poe bot: POE_CATALOG_BOT) ────────────────────────────────
//
// Underlying provider: Google (Gemini)
//
// "Gemini-3.1-Pro" is a Poe-specific bot name.  It does not correspond to any
// model in Google's published model catalogue as of June 2026.  Google's current
// lineup uses "Gemini 2.x" naming (e.g. Gemini 2.5 Pro, Gemini 2.5 Flash).
// Poe likely uses this name for an internal or partner-specific Gemini model.
// Because the exact underlying version is unknown, limits are derived from
// Google's documented caps for Gemini Pro-class models (Gemini 2.5 Pro is the
// closest published equivalent).
//
// Published limits (Google Gemini API — source: ai.google.dev/gemini-api/docs/vision):
//   • Inline image path:       Total request size (images + prompt text) < 20 MB.
//                              Individual image limit is bounded by this total.
//   • File API path:           Recommended for files > ~3–4 MB or when reusing
//                              images across requests; not used by this app.
//   • Max images per request:  16 inline images per request (per Google's docs).
//   • Enforcement layer:       "provider" (Google Gemini API; Poe relay unknown)
//
// Note: "Gemini-3.1-Pro" bot name COULD NOT BE VERIFIED against Google's
// published model list.  Treat all limits as approximate (same as Gemini 2.5 Pro).

/** Max total inline request payload (images + text) for Gemini models (Google limit). */
export const MAX_REQUEST_BYTES_GEMINI_3_1_PRO = 20 * 1024 * 1024; // 20 MB (total inline)

/** Max inline images per request for Gemini models. */
export const MAX_IMAGES_PER_REQUEST_GEMINI_3_1_PRO = 16;

// ── Gemini-2.5-Pro (Poe bot: POE_CATALOG_BOT_FALLBACK) ───────────────────────
//
// Underlying provider: Google (Gemini 2.5 Pro)
//
// This is a published Google Gemini model.
// Limits are the same as for Gemini-3.1-Pro (same Google Gemini inline API limits).
//
// Source: ai.google.dev/gemini-api/docs/models/gemini-2.5-pro
//         ai.google.dev/gemini-api/docs/vision

/** Max total inline request payload for Gemini 2.5 Pro (same as other Gemini models). */
export const MAX_REQUEST_BYTES_GEMINI_2_5_PRO = 20 * 1024 * 1024; // 20 MB (total inline)

/** Max inline images per request for Gemini 2.5 Pro. */
export const MAX_IMAGES_PER_REQUEST_GEMINI_2_5_PRO = 16;

// ── GPT-5-Mini (Poe bot: POE_ENRICH_BOT) ─────────────────────────────────────
//
// Underlying provider: OpenAI
//
// "GPT-5-Mini" is a Poe bot name for a GPT-5 mini-class model.
// This bot is designated TEXT-ONLY in this app (keyword enrichment, reference Q&A).
// It appears last in the identify/dimensions fallback chain, but it is unlikely
// to produce useful results for vision tasks as GPT-5 mini models are optimised
// for text and their vision support is unconfirmed in this Poe context.
//
// If vision IS supported by this Poe bot, the applicable limit is the OpenAI
// standard for GPT-5.x models: 20 MB per image (same as GPT-4o series).
//
// Source: OpenAI API model docs (developers.openai.com/api/docs/models);
//         Poe bot name confirmed working from startup probe (poe-bot-api-protocol.md)
//
// VISION STATUS: NOT CONFIRMED — treat as text-only; images sent to this bot
// as fallback may be silently ignored or trigger an error.

/** Max image size for GPT-5-Mini IF vision is supported (OpenAI standard; unconfirmed on Poe). */
export const MAX_IMAGE_BYTES_GPT5_MINI = 20 * 1024 * 1024; // 20 MB (OpenAI standard)

// ── OpenAI gpt-4o-mini (OpenAI fallback: enrich / reference) ─────────────────
//
// Called via Replit OpenAI Integration (AI_INTEGRATIONS_OPENAI_BASE_URL).
// Used for: keyword enrichment, reference Q&A (text-only in practice).
//
// Published limits (source: platform.openai.com/docs/guides/vision):
//   • Max file size per image:  20 MB
//   • Max images per message:   Not explicitly capped; bounded by context window
//   • Enforcement layer:        "provider" (OpenAI API)
//
// Note: gpt-4o-mini supports vision but the enrich/reference feature does not
// send images; these constants exist for completeness / future use.

/** Max image file size for gpt-4o-mini (OpenAI published limit). */
export const MAX_IMAGE_BYTES_GPT4O_MINI = 20 * 1024 * 1024; // 20 MB

// ── OpenAI gpt-4o (OpenAI fallback: identify / catalog) ──────────────────────
//
// Called via Replit OpenAI Integration.
// Used for: part identification from photos (identify feature),
//           catalog PDF extraction (catalog feature).
//
// Published limits (source: platform.openai.com/docs/guides/vision):
//   • Max file size per image:  20 MB
//   • Max images per message:   Not explicitly capped; bounded by context window
//   • Enforcement layer:        "provider" (OpenAI API)

/** Max image file size for gpt-4o (OpenAI published limit). */
export const MAX_IMAGE_BYTES_GPT4O = 20 * 1024 * 1024; // 20 MB

// ── OpenAI gpt-5.1 (OpenAI fallback: dimensions) ─────────────────────────────
//
// Called via Replit OpenAI Integration.
// Used for: physical dimension estimation from photos.
//
// gpt-5.1 is OpenAI's flagship model for agentic/coding tasks with configurable
// reasoning.  Vision (image input) limits are shared across the GPT-5.x series.
//
// Published limits (source: developers.openai.com/api/docs/guides/images-vision;
//                          developers.openai.com/api/docs/models):
//   • Max file size per image:  20 MB (same as GPT-4o series)
//   • Max images per message:   Not explicitly capped; bounded by context window
//   • Enforcement layer:        "provider" (OpenAI API)

/** Max image file size for gpt-5.1 (OpenAI published limit; same as GPT-5.x series). */
export const MAX_IMAGE_BYTES_GPT5_1 = 20 * 1024 * 1024; // 20 MB

// ── Summary table (human-readable, not for code) ──────────────────────────────
//
//  Model (Poe name)     | Underlying     | Max/img | Max imgs/req | Total req | Enforcement
//  ---------------------|----------------|---------|--------------|-----------|------------
//  GPT-5-Mini           | OpenAI GPT-5   | 20 MB † | unknown †    | unknown † | provider †
//  Claude-Sonnet-4.5    | Anthropic      | 10 MB   | 100          | 32 MB     | provider
//  Gemini-3.1-Pro ‡     | Google Gemini  | <20 MB* | 16           | 20 MB*    | provider
//  Gemini-2.5-Pro       | Google Gemini  | <20 MB* | 16           | 20 MB*    | provider
//
//  OpenAI model         | Via            | Max/img | Max imgs/req | Total req | Enforcement
//  ---------------------|----------------|---------|--------------|-----------|------------
//  gpt-4o-mini          | Replit OAI int | 20 MB   | ctx-bounded  | ctx       | provider
//  gpt-4o               | Replit OAI int | 20 MB   | ctx-bounded  | ctx       | provider
//  gpt-5.1              | Replit OAI int | 20 MB   | ctx-bounded  | ctx       | provider
//
//  † GPT-5-Mini is TEXT-ONLY in this app; vision support unconfirmed on Poe.
//  ‡ "Gemini-3.1-Pro" is a Poe-specific bot name with no published Google equivalent;
//    limits are inferred from Google Gemini Pro-class documentation.
//  * Google Gemini's 20 MB cap is a TOTAL inline request size (images + prompt text combined),
//    not a per-image cap.  Individual images must each fit within this combined budget.
//
// ── App-level enforcement (current) ──────────────────────────────────────────
//
//  artifacts/api-server/src/utils/aiHelpers.ts applies:
//    MAX_IMAGE_PAYLOAD_BYTES = 20 MB  (total payload across all images)
//    Max 4 images per request         (matches UI capture limit)
//
//  artifacts/parts-id/utils/resizeImage.ts downscales on the mobile side:
//    Max width 1920 px, JPEG quality 0.7
//
//  The app-side 20 MB total cap is the binding constraint for most paths.
//  For Claude Sonnet (10 MB per individual image), the per-image limit is tighter
//  than the app's aggregate cap — a single image between 10–20 MB would pass
//  the app check but be rejected by Anthropic.
//
// ── Research gaps ─────────────────────────────────────────────────────────────
//
//  1. Poe relay hard caps: Poe does not publish image size limits for the
//     OpenAI-compatible /v1 endpoint.  The effective limits are assumed to be
//     those of the underlying provider, but Poe may impose lower undocumented
//     caps.  Empirical probing (sending progressively larger images and recording
//     the first error) would establish the actual relay limit.
//
//  2. "Gemini-3.1-Pro" identity: This Poe bot name does not correspond to any
//     published Google model.  The exact model version is unknown.  If Poe
//     updates or removes this bot, the startup probe will log a 404 and the app
//     auto-switches to Gemini-2.5-Pro.
//
//  3. GPT-5-Mini vision support: Whether this Poe bot accepts inline image
//     content (base64 data: URIs in the content array) is unconfirmed.  The app
//     uses it for text-only tasks; if a vision fallback ever reaches it, the
//     response may be empty or an error.

// ── Convenience helpers ───────────────────────────────────────────────────────

/**
 * Return the per-image byte limit for a given Poe bot name.
 * Returns the most restrictive known limit for the underlying provider.
 * Returns `null` when the bot name is unknown.
 */
export function getMaxImageBytesForPoeBot(botName: string): number | null {
  switch (botName) {
    case "Claude-Sonnet-4.5":
      return MAX_IMAGE_BYTES_CLAUDE_SONNET; // 10 MB — Anthropic per-image limit
    case "Gemini-3.1-Pro":
      // Google's 20 MB cap is total request, not per-image; use total as proxy
      return MAX_REQUEST_BYTES_GEMINI_3_1_PRO;
    case "Gemini-2.5-Pro":
      return MAX_REQUEST_BYTES_GEMINI_2_5_PRO;
    case "GPT-5-Mini":
      return MAX_IMAGE_BYTES_GPT5_MINI;
    default:
      return null;
  }
}

/**
 * Return the max images-per-request for a given Poe bot name.
 * Returns `null` when the bot name is unknown.
 */
export function getMaxImagesPerRequestForPoeBot(botName: string): number | null {
  switch (botName) {
    case "Claude-Sonnet-4.5":
      return MAX_IMAGES_PER_REQUEST_CLAUDE_SONNET;
    case "Gemini-3.1-Pro":
      return MAX_IMAGES_PER_REQUEST_GEMINI_3_1_PRO;
    case "Gemini-2.5-Pro":
      return MAX_IMAGES_PER_REQUEST_GEMINI_2_5_PRO;
    case "GPT-5-Mini":
      return null; // Vision support unconfirmed
    default:
      return null;
  }
}

/**
 * Return the per-image byte limit for a given OpenAI model name.
 * Returns `null` when the model is unknown.
 */
export function getMaxImageBytesForOpenAIModel(model: string): number | null {
  switch (model) {
    case "gpt-4o":
      return MAX_IMAGE_BYTES_GPT4O;
    case "gpt-4o-mini":
      return MAX_IMAGE_BYTES_GPT4O_MINI;
    case "gpt-5.1":
      return MAX_IMAGE_BYTES_GPT5_1;
    default:
      return null;
  }
}
