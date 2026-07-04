/**
 * Poe bot caller using the OpenAI-compatible API at https://api.poe.com/v1
 *
 * Key: process.env.POE_API_KEY2
 * Endpoint: POST https://api.poe.com/v1/chat/completions  (NOT /bot/)
 * Model names are Poe display names, e.g. "GPT-4o-Mini", "Claude-Sonnet-4.6"
 *
 * Reference: https://developer.poe.com/server-bots/accessing-other-bots-on-poe
 */

import OpenAI from "openai";

import {
  getAiClient,
  getModelForFeature,
  getPoeChainForFeature,
  getProvider,
  type PoeFeature,
} from "./aiProvider";

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

class PoeBotError extends Error {
  readonly allowRetry: boolean;
  constructor(detail: string, allowRetry: boolean) {
    super(`Poe bot error: ${detail}`);
    this.name = "PoeBotError";
    this.allowRetry = allowRetry;
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
 * been exhausted by transient errors.  Route handlers should surface this as
 * HTTP 503 with `{ status: 'poe_chain_exhausted' }` so the mobile client can
 * prompt the user to retry via OpenAI (x-use-openai-fallback header).
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
 * Call a Poe-backed text feature with automatic sequential chain fallback.
 *
 * When provider is "poe": iterates through the feature's bot chain in order,
 * skipping each bot on transient errors and trying the next one.
 * Throws PoeBotChainExhaustedError when all bots fail with transient errors.
 *
 * When provider is not "poe" (e.g. "openai"): delegates to a single call
 * using the provider's default model — no chaining is applied.
 *
 * Auth errors and other permanent failures are re-thrown immediately without
 * trying the remaining bots.
 */
export async function callPoeBotWithChain(
  feature: PoeFeature,
  systemInstruction: string,
  userMessage: string,
): Promise<string> {
  if (getProvider() !== "poe") {
    // Non-poe provider: use the global AI client (e.g. OpenAI) with the
    // provider's default model — do NOT use the dedicated Poe client.
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
  const chain = getPoeChainForFeature(feature);
  let isFirstAttempt = true;
  for (const botName of chain) {
    if (!isFirstAttempt) await sleep(getChainRetryDelayMs());
    isFirstAttempt = false;
    try {
      return await callPoeBot(botName, systemInstruction, userMessage);
    } catch (err) {
      if (isChainableError(err)) continue;
      throw err;
    }
  }
  throw new PoeBotChainExhaustedError();
}

/**
 * Generic Poe chain helper for multimodal (vision) calls that need a raw
 * OpenAI-compatible client and model name.
 *
 * When provider is "poe": iterates through the feature's bot chain, passing
 * the dedicated Poe client and the candidate bot name to `fn` for each attempt.
 * Throws PoeBotChainExhaustedError when all bots fail with transient errors.
 *
 * When provider is not "poe": calls `fn` once with the active global AI client
 * and the provider's default model for the feature — no chaining is applied.
 *
 * Auth errors and other permanent failures are re-thrown immediately.
 */
export async function tryPoeBotChain<T>(
  feature: PoeFeature,
  fn: (client: OpenAI, modelName: string) => Promise<T>,
): Promise<T> {
  if (getProvider() !== "poe") {
    return fn(getAiClient(), getModelForFeature(feature));
  }
  const chain = getPoeChainForFeature(feature);
  let isFirstAttempt = true;
  for (const botName of chain) {
    if (!isFirstAttempt) await sleep(getChainRetryDelayMs());
    isFirstAttempt = false;
    try {
      return await fn(getClient(), botName);
    } catch (err) {
      if (isChainableError(err)) continue;
      throw err;
    }
  }
  throw new PoeBotChainExhaustedError();
}
