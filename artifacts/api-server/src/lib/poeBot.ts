/**
 * Poe bot caller using the OpenAI-compatible API at https://api.poe.com/v1
 *
 * Key: process.env.POE_API_KEY2
 * Endpoint: POST https://api.poe.com/v1/chat/completions  (NOT /bot/)
 * Model names are Poe display names, e.g. "GPT-4o-Mini", "Claude-Sonnet-4.6"
 *
 * Reference: https://developer.poe.com/server-bots/accessing-other-bots-on-poe
 *
 * Fallback: when all Poe bots in the chain are exhausted — or when a hard
 * quota error (HTTP 402) is returned — the module automatically retries the
 * request using the Replit AI integration (OpenAI-compatible proxy) before
 * raising an error to the caller.  This means the app stays functional even
 * when a Poe API key has run out of credits.
 */

import OpenAI from "openai";

import {
  getAiClient,
  getModelForFeature,
  getOpenAIModelForFeature,
  getPoeChainForFeature,
  getProvider,
  type PoeFeature,
  tryGetOpenAIFallbackClient,
} from "./aiProvider";
import { logger } from "./logger";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env["POE_API_KEY2"];
    if (!apiKey) throw new Error("POE_API_KEY2 is not set");
    _client = new OpenAI({ apiKey, baseURL: "https://api.poe.com/v1" });
  }
  return _client;
}

export class PoeHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`Poe API HTTP ${status}: ${statusText}`);
    this.name = "PoeHttpError";
    this.status = status;
  }
}

export function isPoeCallAuthError(err: unknown): boolean {
  return (
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError
  );
}

export function isPoeCallTransientError(err: unknown): boolean {
  return (
    err instanceof OpenAI.RateLimitError ||
    err instanceof OpenAI.InternalServerError ||
    err instanceof OpenAI.APIConnectionError ||
    err instanceof OpenAI.APIConnectionTimeoutError
  );
}

/**
 * Returns true for Poe quota-exhaustion errors (HTTP 402).
 * When this fires, all bots sharing the same API key will also fail, so the
 * chain is abandoned immediately and the Replit AI fallback is tried instead.
 */
function isPoeQuotaError(err: unknown): boolean {
  const status =
    err != null && typeof err === "object" && "status" in err
      ? (err as { status: unknown }).status
      : undefined;
  return status === 402;
}

/**
 * Call a Poe bot and return the full text response.
 *
 * @param botName           - Poe display-name (e.g. "GPT-4o-Mini", "Claude-Sonnet-4.6").
 * @param systemInstruction - System-prompt text.
 * @param userMessage       - User turn content.
 */
export async function callPoeBot(
  botName: string,
  systemInstruction: string,
  userMessage: string,
): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: botName,
    max_completion_tokens: 512,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

// ── Fallback chain utilities ──────────────────────────────────────────────────

/**
 * Sentinel error thrown when all Poe bots in a feature's fallback chain have
 * been exhausted by transient errors AND the Replit AI fallback is not
 * configured.  Route handlers should surface this as HTTP 503 with
 * `{ status: 'poe_chain_exhausted' }` so the mobile client can prompt the
 * user to retry via OpenAI (x-use-openai-fallback header).
 */
export class PoeBotChainExhaustedError extends Error {
  constructor() {
    super("All Poe bots in the fallback chain failed");
    this.name = "PoeBotChainExhaustedError";
  }
}

function isChainableError(err: unknown): boolean {
  return isPoeCallTransientError(err) || err instanceof PoeHttpError;
}

function getChainRetryDelayMs(): number {
  const raw = process.env["POE_CHAIN_RETRY_DELAY_MS"];
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt the Replit AI integration (OpenAI-compatible) for a text feature.
 * Returns the response text, or re-throws `originalErr` if the fallback client
 * is not configured.
 */
async function _replitAITextFallback(
  feature: PoeFeature,
  systemInstruction: string,
  userMessage: string,
  originalErr: unknown,
): Promise<string> {
  const replitClient = tryGetOpenAIFallbackClient();
  if (!replitClient) throw originalErr;

  const reason =
    originalErr instanceof Error ? originalErr.message : String(originalErr);
  logger.warn(
    { feature, reason },
    "Poe unavailable — falling back to Replit AI",
  );

  const response = await replitClient.chat.completions.create({
    model: getOpenAIModelForFeature(feature),
    max_completion_tokens: 512,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Attempt the Replit AI integration (OpenAI-compatible) for a vision/generic
 * feature via the caller-supplied `fn`.  Returns the result, or re-throws
 * `originalErr` if the fallback client is not configured.
 */
async function _replitAIGenericFallback<T>(
  feature: PoeFeature,
  fn: (client: OpenAI, modelName: string) => Promise<T>,
  originalErr: unknown,
): Promise<T> {
  const replitClient = tryGetOpenAIFallbackClient();
  if (!replitClient) throw originalErr;

  const reason =
    originalErr instanceof Error ? originalErr.message : String(originalErr);
  logger.warn(
    { feature, reason },
    "Poe unavailable — falling back to Replit AI",
  );

  return fn(replitClient, getOpenAIModelForFeature(feature));
}

/**
 * Call a Poe-backed text feature with automatic sequential chain fallback,
 * then Replit AI as a final backstop.
 *
 * When provider is "poe":
 *   1. Iterates through the feature's bot chain in order, skipping each bot
 *      on transient errors and trying the next one.
 *   2. On a quota error (HTTP 402) — which affects the whole key — the chain
 *      is abandoned immediately and step 3 runs.
 *   3. If the chain is exhausted (or a quota error fires), the call is retried
 *      once using the Replit AI integration (gpt-5.6-terra / gpt-5.4 depending
 *      on feature).  If the Replit AI env vars are not set the original error
 *      is re-thrown.
 *
 * Auth errors (wrong key, permission denied) are re-thrown immediately without
 * trying any fallback.
 *
 * When provider is not "poe" (e.g. "openai"): delegates to a single call
 * using the provider's default model — no chaining or fallback is applied.
 */
export async function callPoeBotWithChain(
  feature: PoeFeature,
  systemInstruction: string,
  userMessage: string,
): Promise<string> {
  if (getProvider() !== "poe") {
    const response = await getAiClient().chat.completions.create({
      model: getModelForFeature(feature),
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userMessage },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ?? "";
  }

  let chainErr: unknown = new PoeBotChainExhaustedError();
  const chain = getPoeChainForFeature(feature);
  let isFirstAttempt = true;

  for (const botName of chain) {
    if (!isFirstAttempt) await sleep(getChainRetryDelayMs());
    isFirstAttempt = false;
    try {
      return await callPoeBot(botName, systemInstruction, userMessage);
    } catch (err) {
      // Auth errors: propagate immediately — no point trying other bots or Replit AI.
      if (isPoeCallAuthError(err)) throw err;
      chainErr = err;
      // Quota error: the entire API key is exhausted — abandon the chain now.
      if (isPoeQuotaError(err)) break;
      // Transient errors: try the next bot in the chain.
      if (isChainableError(err)) continue;
      // Any other hard error: abandon the chain and try Replit AI.
      break;
    }
  }

  // Poe chain failed — try Replit AI before giving up.
  return _replitAITextFallback(feature, systemInstruction, userMessage, chainErr);
}

/**
 * Generic Poe chain helper for multimodal (vision) calls that need a raw
 * OpenAI-compatible client and model name, with Replit AI as a final backstop.
 *
 * When provider is "poe":
 *   1. Iterates through the feature's bot chain, passing the dedicated Poe
 *      client and the candidate bot name to `fn` for each attempt.
 *   2. On a quota error (HTTP 402) the chain is abandoned immediately.
 *   3. If the chain is exhausted or a quota/hard error fires, `fn` is called
 *      once more with the Replit AI client and the OpenAI model for the
 *      feature.  If Replit AI env vars are not set the original error is
 *      re-thrown.
 *
 * Auth errors are re-thrown immediately without any fallback.
 *
 * When provider is not "poe": calls `fn` once with the active global AI client
 * and the provider's default model — no chaining or fallback is applied.
 */
export async function tryPoeBotChain<T>(
  feature: PoeFeature,
  fn: (client: OpenAI, modelName: string) => Promise<T>,
): Promise<T> {
  if (getProvider() !== "poe") {
    return fn(getAiClient(), getModelForFeature(feature));
  }

  let chainErr: unknown = new PoeBotChainExhaustedError();
  const chain = getPoeChainForFeature(feature);
  let isFirstAttempt = true;

  for (const botName of chain) {
    if (!isFirstAttempt) await sleep(getChainRetryDelayMs());
    isFirstAttempt = false;
    try {
      return await fn(getClient(), botName);
    } catch (err) {
      if (isPoeCallAuthError(err)) throw err;
      chainErr = err;
      if (isPoeQuotaError(err)) break;
      if (isChainableError(err)) continue;
      break;
    }
  }

  // Poe chain failed — try Replit AI before giving up.
  return _replitAIGenericFallback(feature, fn, chainErr);
}
