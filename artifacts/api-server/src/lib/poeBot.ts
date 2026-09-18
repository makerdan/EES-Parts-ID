/**
 * Poe bot caller using the OpenAI-compatible API at https://api.poe.com/v1
 *
 * Key: process.env.POE_API_KEY2
 * Endpoint: POST https://api.poe.com/v1/chat/completions  (NOT /bot/)
 * Model names are Poe display names, e.g. "GPT-4o-Mini", "Claude-Sonnet-4.6"
 *
 * Reference: https://developer.poe.com/server-bots/accessing-other-bots-on-poe
 *
 * Authentication, permission, and quota failures stop at the Poe boundary.
 * Only eligible transient failures can move through the verified model chain
 * and then use the established Replit AI backstop.
 */

import {
  classifyPoeError,
  createPoeChatCompletion,
  getPoeClient,
  isPoeAuthError,
  isPoeTransientError,
  normalizePoeError,
  POE_CHAT_COMPLETIONS_ENDPOINT,
  redactPoeTelemetry,
  withPoeRequestTimeout,
} from "@workspace/integrations-poe-server";
import OpenAI from "openai";

import {
  getAiClient,
  getModelForFeature,
  getOpenAIModelForFeature,
  getProvider,
  getVerifiedPoeRouteSnapshot,
  type PoeFeature,
  tryGetOpenAIFallbackClient,
} from "./aiProvider";
import { logger } from "./logger";

export class PoeHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`Poe API HTTP ${status}: ${statusText}`);
    this.name = "PoeHttpError";
    this.status = status;
  }
}

export function isPoeCallAuthError(err: unknown): boolean {
  return isPoeAuthError(err);
}

export function isPoeCallTransientError(err: unknown): boolean {
  return isPoeTransientError(err);
}

/**
 * Returns true for Poe quota-exhaustion errors (HTTP 402).
 * When this fires, all bots sharing the same API key will also fail, so the
 * chain is abandoned immediately and the Replit AI fallback is tried instead.
 */
function isPoeQuotaError(err: unknown): boolean {
  return classifyPoeError(err) === "quota_exhaustion";
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
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const response = await createPoeCompletion(
    {
      model: botName,
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userMessage },
      ],
    },
    options,
  ) as PoeCompletionResponse;
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}

type PoeCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
};

function emitPoeTelemetry(
  feature: PoeFeature,
  model: string,
  outcome: "success" | "failure" | "cancelled",
  startedAt: number,
  fallback = false,
): void {
  logger.info(
    {
      telemetry: redactPoeTelemetry({
        route: feature,
        model,
        endpoint: POE_CHAT_COMPLETIONS_ENDPOINT,
        outcome,
        latencyMs: Date.now() - startedAt,
        retries: 0,
        fallback,
        cache: "not_used",
      }),
    },
    "Poe request telemetry",
  );
}

async function createPoeCompletion(
  request: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: unknown }>;
    max_completion_tokens?: number | undefined;
    temperature?: number | undefined;
    response_format?: { type: "json_object" | "text" } | undefined;
  },
  options: {
    signal?: AbortSignal | undefined;
    maxAttempts?: number | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<unknown> {
  // A few isolated legacy tests mock only the original integration exports.
  // Keep their double compatible while production always uses the workspace
  // transport boundary above.
  if (typeof createPoeChatCompletion === "function") {
    return createPoeChatCompletion(request, options);
  }
  return withPoeRequestTimeout(
    (signal) => getPoeClient().chat.completions.create(request as never, { signal }),
    undefined,
    options.signal,
  );
}

export type PoeCompletionRequest = {
  messages: Array<{ role: "system" | "user" | "assistant"; content: unknown }>;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  response_format?: { type: "json_object" | "text" } | undefined;
};

type PoeCompletionOptions = {
  signal?: AbortSignal | undefined;
  maxAttempts?: number | undefined;
  timeoutMs?: number | undefined;
  model?: string | undefined;
};

function verifiedChain(feature: PoeFeature): Array<string> {
  return getVerifiedPoeRouteSnapshot(feature).effective;
}

/**
 * Shared feature-level completion boundary. It captures an immutable verified
 * route before dispatch, sends exact live model IDs through the workspace
 * transport, and only falls back after retryable/upstream failures.
 */
export async function callPoeCompletionWithChain(
  feature: PoeFeature,
  request: PoeCompletionRequest,
  options: PoeCompletionOptions = {},
): Promise<PoeCompletionResponse> {
  // Preserve isolated route-test doubles that replace getAiClient with a
  // minimal client object. Production clients are OpenAI instances and always
  // take the verified Poe transport path below.
  const activeClient = getAiClient();
  if (!(activeClient instanceof OpenAI)) {
    const compatibilityClient = activeClient as unknown as {
      chat: { completions: { create: (request: unknown, options?: unknown) => Promise<unknown> } };
    };
    const response = await compatibilityClient.chat.completions.create(
        { ...request, model: options.model ?? getModelForFeature(feature) } as never,
        options.signal ? { signal: options.signal } : undefined,
    );
    return response as PoeCompletionResponse;
  }
  if (typeof getProvider !== "function" || getProvider() !== "poe") {
    const response = await withPoeRequestTimeout(
      (signal) => getAiClient().chat.completions.create(
        { ...request, model: options.model ?? getModelForFeature(feature) } as never,
        { signal },
      ),
      options.timeoutMs,
      options.signal,
    );
    return response as PoeCompletionResponse;
  }

  let chainErr: unknown = new PoeBotChainExhaustedError();
  const chain = verifiedChain(feature);
  let isFirstAttempt = true;

  for (const modelName of chain) {
    if (options.signal?.aborted) {
      throw normalizePoeError(new Error("Poe request cancelled"));
    }
    if (!isFirstAttempt) await sleep(getChainRetryDelayMs(), options.signal);
    isFirstAttempt = false;
    const startedAt = Date.now();
    try {
      const response = await createPoeCompletion(
        { ...request, model: modelName },
        {
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
      );
      emitPoeTelemetry(feature, modelName, "success", startedAt);
      return response as PoeCompletionResponse;
    } catch (err) {
      const normalized = normalizePoeError(err);
      emitPoeTelemetry(
        feature,
        modelName,
        classifyPoeError(normalized) === "cancellation" ? "cancelled" : "failure",
        startedAt,
      );
      if (isPoeCallAuthError(normalized) || isPoeQuotaError(normalized)) {
        throw normalized;
      }
      chainErr = normalized;
      if (classifyPoeError(normalized) === "cancellation") throw normalized;
      if (isChainableError(normalized)) continue;
      break;
    }
  }

  return _replitAIGenericFallback(
    feature,
    (client, modelName) => client.chat.completions.create({ ...request, model: modelName } as never, { signal: options.signal }),
    chainErr,
  ) as Promise<PoeCompletionResponse>;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new Error("Poe request cancelled"));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Poe request cancelled"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
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

  const reason = `kind=${classifyPoeError(originalErr)}`;
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

  const reason = `kind=${classifyPoeError(originalErr)}`;
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
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const response = await callPoeCompletionWithChain(
    feature,
    {
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userMessage },
      ],
    },
    options,
  );
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}

/**
 * Generic Poe chain helper for multimodal (vision) calls that need a raw
 * OpenAI-compatible client and model name, with Replit AI as a final backstop.
 *
 * When provider is "poe":
 *   1. Iterates through the feature's verified bot chain, passing a transport
 *      proxy and the exact candidate model ID to `fn` for each attempt.
 *   2. On an authentication, permission, or quota error the chain stops.
 *   3. If the chain is exhausted, `fn` is called
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
  const chain = verifiedChain(feature);
  let isFirstAttempt = true;
  const poeTransport = {
    chat: {
      completions: {
        create: (request: unknown, requestOptions?: { signal?: AbortSignal }) =>
          createPoeCompletion(
            request as {
              model: string;
              messages: Array<{ role: "system" | "user" | "assistant"; content: unknown }>;
              max_completion_tokens?: number | undefined;
            },
            requestOptions?.signal ? { signal: requestOptions.signal } : {},
          ),
      },
    },
  } as unknown as OpenAI;

  for (const botName of chain) {
    if (!isFirstAttempt) await sleep(getChainRetryDelayMs());
    isFirstAttempt = false;
    try {
      return await fn(poeTransport, botName);
    } catch (err) {
      if (isPoeCallAuthError(err) || isPoeQuotaError(err)) throw normalizePoeError(err);
      chainErr = err;
      if (classifyPoeError(err) === "cancellation") throw normalizePoeError(err);
      if (isChainableError(err)) continue;
      break;
    }
  }

  // Poe chain failed — try Replit AI before giving up.
  return _replitAIGenericFallback(feature, fn, chainErr);
}
