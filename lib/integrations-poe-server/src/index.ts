import OpenAI from "openai";

let _poeClient: OpenAI | null = null;

export const POE_BASE_URL = "https://api.poe.com/v1";
export const POE_CHAT_COMPLETIONS_ENDPOINT = `${POE_BASE_URL}/chat/completions`;
export const POE_REQUEST_TIMEOUT_MS = 30_000;

export function getPoeClient(): OpenAI {
  if (!_poeClient) {
    if (!process.env.POE_API_KEY2) {
      throw new Error(
        "POE_API_KEY2 must be set. Did you forget to add the Poe API key secret?",
      );
    }
    _poeClient = new OpenAI({
      apiKey: process.env.POE_API_KEY2,
      baseURL: POE_BASE_URL,
    });
  }
  return _poeClient;
}

/** Reset the shared client when the active provider is deliberately switched. */
export function resetPoeClient(): void {
  _poeClient = null;
}

export type PoeErrorKind =
  | "authentication"
  | "permission"
  | "quota_exhaustion"
  | "rate_limited"
  | "unavailable_model"
  | "unsupported_capability"
  | "timeout"
  | "cancellation"
  | "invalid_request"
  | "upstream";

export interface PoeTelemetryMetadata {
  route: string;
  model: string;
  endpoint: string;
  outcome: "success" | "failure" | "cancelled";
  latencyMs: number;
  retries: number;
  fallback: boolean;
  cache: "hit" | "miss" | "not_used";
  usage?: { inputTokens?: number; outputTokens?: number } | undefined;
  requestId?: string | undefined;
}

/** Keep operational metadata bounded and structurally incapable of holding prompts. */
export function redactPoeTelemetry(metadata: PoeTelemetryMetadata): PoeTelemetryMetadata {
  return {
    route: metadata.route.slice(0, 64),
    model: metadata.model.slice(0, 128),
    endpoint: metadata.endpoint === POE_CHAT_COMPLETIONS_ENDPOINT
      ? metadata.endpoint
      : POE_CHAT_COMPLETIONS_ENDPOINT,
    outcome: metadata.outcome,
    latencyMs: Math.max(0, Math.min(Math.round(metadata.latencyMs), 86_400_000)),
    retries: Math.max(0, Math.min(Math.round(metadata.retries), 3)),
    fallback: Boolean(metadata.fallback),
    cache: metadata.cache,
    ...(metadata.usage
      ? {
          usage: {
            ...(metadata.usage.inputTokens !== undefined
              ? { inputTokens: Math.max(0, Math.min(Math.round(metadata.usage.inputTokens), 10_000_000)) }
              : {}),
            ...(metadata.usage.outputTokens !== undefined
              ? { outputTokens: Math.max(0, Math.min(Math.round(metadata.usage.outputTokens), 10_000_000)) }
              : {}),
          },
        }
      : {}),
    ...(metadata.requestId ? { requestId: metadata.requestId.slice(0, 128) } : {}),
  };
}

class PoeProviderError extends Error {
  readonly kind: PoeErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;
  readonly cause: unknown;

  constructor(
    kind: PoeErrorKind,
    message: string,
    options: {
      status?: number | undefined;
      retryAfterMs?: number | undefined;
      requestId?: string | undefined;
      cause?: unknown | undefined;
    } = {},
  ) {
    super(message);
    this.name = "PoeProviderError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
    this.cause = options.cause;
  }
}

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function headerOf(err: unknown, name: string): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const candidate = record[name] ?? record[name.toLowerCase()];
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof (candidate as { get?: unknown }).get === "function") {
    const value = (candidate as { get: (key: string) => unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function retryAfterMsOf(err: unknown): number | undefined {
  const value = headerOf(err, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 60_000)) : undefined;
}

function requestIdOf(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const value = (err as { request_id?: unknown }).request_id ??
    (err as { requestId?: unknown }).requestId;
  return typeof value === "string" ? value.slice(0, 128) : undefined;
}

/**
 * Classify provider failures once at the transport boundary. Callers should
 * use this vocabulary rather than inspecting SDK classes or status codes.
 */
export function classifyPoeError(err: unknown): PoeErrorKind {
  if (err instanceof PoeProviderError) return err.kind;
  const constructors = OpenAI as unknown as Record<string, unknown>;
  const is = (name: string) => {
    const ctor = constructors[name];
    return typeof ctor === "function" && err instanceof (ctor as new (...args: Array<never>) => object);
  };
  if (is("AuthenticationError") || statusOf(err) === 401) {
    return "authentication";
  }
  if (is("PermissionDeniedError") || statusOf(err) === 403) {
    return "permission";
  }
  if (statusOf(err) === 402) {
    return "quota_exhaustion";
  }
  if (is("RateLimitError") || statusOf(err) === 429) {
    return "rate_limited";
  }
  if (is("NotFoundError") || statusOf(err) === 404) {
    return "unavailable_model";
  }
  if (statusOf(err) === 400 || statusOf(err) === 422) {
    return "invalid_request";
  }
  if (err instanceof Error && err.name === "PoeCancellationError") {
    return "cancellation";
  }
  if (
    is("APIConnectionTimeoutError") ||
    (err instanceof Error && err.name === "AbortError")
  ) {
    return "timeout";
  }
  if (is("APIConnectionError") || is("InternalServerError") || (statusOf(err) ?? 0) >= 500) {
    return "upstream";
  }
  return "upstream";
}

export function normalizePoeError(err: unknown): PoeProviderError {
  if (err instanceof PoeProviderError) return err;
  const options = {
    ...(statusOf(err) !== undefined ? { status: statusOf(err) } : {}),
    ...(retryAfterMsOf(err) !== undefined ? { retryAfterMs: retryAfterMsOf(err) } : {}),
    ...(requestIdOf(err) !== undefined ? { requestId: requestIdOf(err) } : {}),
    cause: err,
  };
  return new PoeProviderError(
    classifyPoeError(err),
    err instanceof Error ? err.message : "Poe provider request failed",
    options,
  );
}

export function isPoeRetryableKind(kind: PoeErrorKind): boolean {
  return kind === "rate_limited" || kind === "timeout" || kind === "upstream";
}

export function isPoeCancellation(err: unknown): boolean {
  return classifyPoeError(err) === "cancellation";
}

function composeAbortSignal(parentSignal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!parentSignal) return () => {};
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  return () => parentSignal.removeEventListener("abort", abort);
}

export async function withPoeRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = POE_REQUEST_TIMEOUT_MS,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const removeParentListener = composeAbortSignal(parentSignal, controller);
  if (controller.signal.aborted) {
    removeParentListener();
    throw new PoeProviderError("cancellation", "Poe request cancelled");
  }
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PoeProviderError("timeout", `Poe request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (err) {
      if (parentSignal?.aborted) {
        throw new PoeProviderError("cancellation", "Poe request cancelled", { cause: err });
      }
      throw normalizePoeError(err);
    }
  } finally {
    if (timer) clearTimeout(timer);
    removeParentListener();
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      return Promise.reject(new PoeProviderError("cancellation", "Poe request cancelled"));
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
      timer = undefined;
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    const abort = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      cleanup();
      reject(new PoeProviderError("cancellation", "Poe request cancelled"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface PoeRetryOptions {
  maxAttempts?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onRetry?: ((metadata: { attempt: number; delayMs: number; kind: PoeErrorKind }) => void) | undefined;
}

/** Retry only transient failures, with a bounded and cancellable backoff. */
export async function withPoeRetry<T>(
  operation: (attempt: number, signal: AbortSignal) => Promise<T>,
  options: PoeRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3));
  const baseDelayMs = Math.max(0, Math.min(options.baseDelayMs ?? 250, 5_000));
  const maxDelayMs = Math.max(baseDelayMs, Math.min(options.maxDelayMs ?? 4_000, 30_000));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withPoeRequestTimeout(
        (signal) => operation(attempt, signal),
        options.timeoutMs ?? POE_REQUEST_TIMEOUT_MS,
        options.signal,
      );
    } catch (err) {
      const normalized = normalizePoeError(err);
      lastError = normalized;
      if (
        attempt >= maxAttempts ||
        !isPoeRetryableKind(normalized.kind)
      ) {
        throw normalized;
      }
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.max(exponential, normalized.retryAfterMs ?? 0);
      options.onRetry?.({ attempt, delayMs, kind: normalized.kind });
      await sleepWithSignal(delayMs, options.signal);
    }
  }
  throw normalizePoeError(lastError);
}

export type PoeChatMessage = {
  role: "system" | "user" | "assistant";
  content: unknown;
};

export interface PoeChatCompletionRequest {
  model: string;
  messages: Array<PoeChatMessage>;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  response_format?: { type: "json_object" | "text" } | undefined;
}

/** The sole Poe request-construction boundary used by server callers. */
export async function createPoeChatCompletion(
  request: PoeChatCompletionRequest,
  options: {
    signal?: AbortSignal | undefined;
    maxAttempts?: number | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<unknown> {
  return withPoeRetry(
    (_attempt, signal) => {
      const create = getPoeClient().chat.completions.create;
      // Older deterministic admin-probe doubles model the one-argument
      // OpenAI call. Keep that compatibility shape in tests while the real
      // client receives the composed abort signal.
      if (typeof create === "function" && "_isMockFunction" in create) {
        return create.call(getPoeClient().chat.completions, request as never);
      }
      return create.call(getPoeClient().chat.completions, request as never, { signal });
    },
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
  );
}

export interface PoeCatalogueModel {
  id: string;
  name: string;
  modalities: Array<string>;
  endpoint: string;
  parameters: {
    maxCompletionTokens: number | null;
    temperature: boolean | null;
    responseFormat: boolean | null;
  };
  limits: {
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
    maxImages: number | null;
    maxImageBytes: number | null;
  };
  capabilities: {
    text: boolean | null;
    vision: boolean | null;
    structuredOutput: boolean | null;
  };
  capabilityConfidence: "verified" | "inferred" | "unknown";
  verification: {
    source: "live_catalogue" | "probe" | "unknown";
    owner: string;
    verifiedAt: string | null;
  };
  approvedUse: Array<string>;
  privacy: "prompt_not_persisted";
  costNote: string;
  latencyNote: string;
  raw?: Record<string, unknown>;
}

function stringArray(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
    : [];
}

function booleanCapability(
  source: Record<string, unknown>,
  keys: Array<string>,
): boolean | null {
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key] as boolean;
  }
  return null;
}

/** Normalize the deliberately loose model metadata returned by Poe. */
export function normalizePoeModel(raw: unknown): PoeCatalogueModel | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const name =
    typeof source.name === "string"
      ? source.name.trim()
      : typeof source.display_name === "string"
        ? source.display_name.trim()
        : id;
  if (!id && !name) return null;

  const capabilitySource =
    source.capabilities && typeof source.capabilities === "object"
      ? (source.capabilities as Record<string, unknown>)
      : source;
  const modalities: Array<string> = [
    ...stringArray(source.modalities),
    ...stringArray(source.input_modalities),
    ...stringArray(source.inputModalities),
    ...stringArray(capabilitySource.modalities),
  ];
  const hasVisionModality = modalities.some((item) =>
    ["vision", "image", "images", "multimodal"].includes(item),
  );
  const hasTextModality = modalities.some((item) =>
    ["text", "input_text", "text_input"].includes(item),
  );
  const structuredModality = modalities.some((item) =>
    ["json", "structured", "structured_output", "function_calling"].includes(item),
  );

  const text =
    booleanCapability(capabilitySource, ["text", "text_input", "supports_text"]) ??
    (modalities.length > 0 ? hasTextModality : null);
  const vision =
    booleanCapability(capabilitySource, ["vision", "image", "supports_vision"]) ??
    (modalities.length > 0 ? hasVisionModality : null);
  const structuredOutput =
    booleanCapability(capabilitySource, [
      "structured_output",
      "structuredOutput",
      "json_mode",
      "jsonMode",
      "function_calling",
    ]) ?? (modalities.length > 0 ? structuredModality : null);

  const numberValue = (keys: Array<string>): number | null => {
    for (const key of keys) {
      if (typeof source[key] === "number" && Number.isFinite(source[key])) {
        return source[key] as number;
      }
      if (
        typeof capabilitySource[key] === "number" &&
        Number.isFinite(capabilitySource[key])
      ) {
        return capabilitySource[key] as number;
      }
    }
    return null;
  };
  const boolValue = (keys: Array<string>): boolean | null =>
    booleanCapability(source, keys) ?? booleanCapability(capabilitySource, keys);
  const capabilityValues = [text, vision, structuredOutput];
  const capabilityConfidence =
    capabilityValues.every((value) => value !== null)
      ? "verified"
      : modalities.length > 0
        ? "inferred"
        : "unknown";

  return {
    id: id || name,
    name: name || id,
    modalities: [...new Set(modalities)],
    endpoint:
      typeof source.endpoint === "string"
        ? source.endpoint
        : POE_CHAT_COMPLETIONS_ENDPOINT,
    parameters: {
      maxCompletionTokens: numberValue(["max_completion_tokens", "max_output_tokens"]),
      temperature: boolValue(["temperature", "supports_temperature"]),
      responseFormat: boolValue(["response_format", "json_mode", "supports_response_format"]),
    },
    limits: {
      maxInputTokens: numberValue(["max_input_tokens", "context_length", "context_window"]),
      maxOutputTokens: numberValue(["max_output_tokens", "max_completion_tokens"]),
      maxImages: numberValue(["max_images", "max_images_per_request"]),
      maxImageBytes: numberValue(["max_image_bytes", "max_image_size_bytes"]),
    },
    capabilities: { text, vision, structuredOutput },
    capabilityConfidence,
    verification: {
      source: "live_catalogue",
      owner: "api-server",
      verifiedAt: new Date().toISOString(),
    },
    approvedUse: Array.isArray(source.approved_use)
      ? source.approved_use
        .filter((value): value is string => typeof value === "string")
        .slice(0, 16)
      : [],
    privacy: "prompt_not_persisted",
    costNote:
      typeof source.cost_note === "string"
        ? source.cost_note.slice(0, 240)
        : "Provider pricing varies by live Poe model.",
    latencyNote:
      typeof source.latency_note === "string"
        ? source.latency_note.slice(0, 240)
        : "Latency varies by provider load and model.",
    raw: source,
  };
}

/** Fetch and normalize the live Poe model catalogue. */
export async function listPoeModels(): Promise<Array<PoeCatalogueModel>> {
  const response = await withPoeRequestTimeout((signal) =>
    getPoeClient().models.list({ signal }),
  );
  const data = (response as unknown as { data?: unknown }).data;
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map(normalizePoeModel)
    .filter((model): model is PoeCatalogueModel => model !== null);
}

/**
 * Returns true if the error is a Poe authentication or authorization failure
 * (invalid/revoked key, bot access denied). These errors will not resolve on
 * retry — the operator must fix the API key or subscription.
 */
export function isPoeAuthError(err: unknown): boolean {
  const kind = classifyPoeError(err);
  return kind === "authentication" || kind === "permission";
}

/**
 * Returns true if the error is likely transient (rate limit, server error,
 * network timeout) and worth retrying after a backoff.
 */
export function isPoeTransientError(err: unknown): boolean {
  if (!(err instanceof PoeProviderError)) {
    const constructors = OpenAI as unknown as Record<string, unknown>;
    const knownTransient = ["RateLimitError", "InternalServerError", "APIConnectionError", "APIConnectionTimeoutError"]
      .some((name) => {
        const ctor = constructors[name];
        return typeof ctor === "function" && err instanceof (ctor as new (...args: Array<never>) => object);
      });
    const status = statusOf(err);
    if (!knownTransient && (status === undefined || status < 429 || status === 401 || status === 403 || status === 402 || status === 404)) {
      return false;
    }
  }
  const kind = classifyPoeError(err);
  return kind === "rate_limited" || kind === "upstream" || kind === "timeout";
}

/**
 * Returns a human-readable message for a known Poe API error,
 * or null if the error is not a recognised Poe API error.
 */
export function poeErrorMessage(err: unknown): string | null {
  if (!(err instanceof PoeProviderError)) {
    const constructors = OpenAI as unknown as Record<string, unknown>;
    const knownProviderError = [
      "AuthenticationError",
      "PermissionDeniedError",
      "RateLimitError",
      "NotFoundError",
      "BadRequestError",
      "UnprocessableEntityError",
      "APIConnectionError",
      "APIConnectionTimeoutError",
      "InternalServerError",
    ].some((name) => {
      const ctor = constructors[name];
      return typeof ctor === "function" && err instanceof (ctor as new (...args: Array<never>) => object);
    });
    if (!knownProviderError && statusOf(err) === undefined) return null;
  }
  const kind = classifyPoeError(err);
  if (kind === "authentication") {
    return "Poe API key is invalid or has been revoked. Check the POE_API_KEY2 secret.";
  }
  if (kind === "permission") {
    return "Poe API key does not have access to the requested bot. Check your Poe subscription or bot permissions.";
  }
  if (kind === "quota_exhaustion") {
    return "Poe API quota is exhausted. Contact the Poe account owner.";
  }
  if (kind === "rate_limited") {
    return "Poe API rate limit exceeded. Please retry shortly.";
  }
  if (kind === "unavailable_model") {
    return "Poe bot not found. Check the model name is correct.";
  }
  if (kind === "unsupported_capability") {
    return "The selected Poe model does not support this request.";
  }
  if (kind === "timeout") {
    return "Poe request timed out. Please retry shortly.";
  }
  if (kind === "cancellation") {
    return "Poe request was cancelled.";
  }
  if (kind === "invalid_request") {
    return "Poe rejected the request as invalid.";
  }
  return kind === "upstream"
    ? "Poe is temporarily unavailable. Please retry shortly."
    : null;
}
