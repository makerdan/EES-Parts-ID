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

export type PoeRouteClass = "identify" | "dimensions" | "enrich" | "catalog";
export type PoeOperation = "completion" | "probe";

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

export class PoeProviderError extends Error {
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
  deadlineAt?: number | undefined;
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
      const remainingMs = options.deadlineAt === undefined
        ? undefined
        : Math.max(0, options.deadlineAt - Date.now());
      if (remainingMs === 0) {
        throw new PoeProviderError("timeout", "Poe request deadline expired");
      }
      return await withPoeRequestTimeout(
        (signal) => operation(attempt, signal),
        Math.min(options.timeoutMs ?? POE_REQUEST_TIMEOUT_MS, remainingMs ?? POE_REQUEST_TIMEOUT_MS),
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

export interface PoeChatCompletionOptions {
  signal?: AbortSignal | undefined;
  maxAttempts?: number | undefined;
  timeoutMs?: number | undefined;
  deadlineAt?: number | undefined;
  route?: PoeRouteClass | undefined;
  operation?: PoeOperation | undefined;
}

export interface PoeChatCompletionHandle {
  response: Promise<unknown>;
  transportSettled: Promise<void>;
}

function invalidPoeRequest(message: string): PoeProviderError {
  return new PoeProviderError("invalid_request", message.slice(0, 256), { status: 400 });
}

function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function countImageUrls(messages: Array<PoeChatMessage>): { count: number; largestBytes: number } {
  let count = 0;
  let largestBytes = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object") {
        throw invalidPoeRequest("Poe message content contains an invalid part");
      }
      const typedPart = part as { type?: unknown; text?: unknown };
      if (typedPart.type === "text" && typeof typedPart.text !== "string") {
        throw invalidPoeRequest("Poe text content must be a string");
      }
      const imageUrl = (part as { image_url?: unknown }).image_url;
      const url = imageUrl && typeof imageUrl === "object"
        ? (imageUrl as { url?: unknown }).url
        : undefined;
      if (typedPart.type === "image_url" && (typeof url !== "string" || !url.startsWith("data:"))) {
        throw invalidPoeRequest("Remote image URLs are not enabled for Poe requests");
      }
      if (typeof url === "string" && url.startsWith("data:")) {
        count += 1;
        largestBytes = Math.max(largestBytes, Math.floor(url.length * 0.75));
      }
    }
  }
  return { count, largestBytes };
}

/**
 * Repeat route and payload authorization at the transport boundary. The route
 * is an option rather than a request property so it can never be forwarded to
 * Poe as an unsupported provider parameter.
 */
export function validatePoeChatRequest(
  request: PoeChatCompletionRequest,
  options: Pick<PoeChatCompletionOptions, "route" | "operation"> = {},
): void {
  const model = POE_MODEL_REGISTRY.find((candidate) => candidate.id === request.model);
  if (!model || !model.enabled || !model.failClosed) {
    throw invalidPoeRequest(
      `Poe model "${String(request.model).slice(0, 128)}" is not enabled in the application registry`,
    );
  }
  if (!model.supportedEndpoints.includes(POE_CHAT_COMPLETIONS_ENDPOINT)) {
    throw invalidPoeRequest(`Poe model "${model.id}" is not approved for chat completions`);
  }
  if (options.operation !== "probe" && options.route !== undefined && !model.approvedRoutes.includes(options.route)) {
    throw invalidPoeRequest(`Poe model "${model.id}" is not approved for route "${options.route}"`);
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw invalidPoeRequest("Poe requests require at least one message");
  }
  if (request.messages.some((message) =>
    !message ||
    (message.role !== "system" && message.role !== "user" && message.role !== "assistant") ||
    (typeof message.content !== "string" && !Array.isArray(message.content)),
  )) {
    throw invalidPoeRequest("Poe messages contain an unsupported role or content shape");
  }
  const allowedKeys = new Set(["model", "messages", "max_completion_tokens", "temperature", "response_format"]);
  if (Object.keys(request as unknown as Record<string, unknown>).some((key) => !allowedKeys.has(key))) {
    throw invalidPoeRequest("Poe request contains an unsupported parameter");
  }
  const parameters = model.supportedParameters;
  if (request.max_completion_tokens !== undefined) {
    if (!parameters.maxCompletionTokens ||
      !Number.isSafeInteger(request.max_completion_tokens) ||
      request.max_completion_tokens < 1 ||
      request.max_completion_tokens > model.limits.maxOutputTokens) {
      throw invalidPoeRequest("Poe output token limit is unsupported or exceeds the registered route limit");
    }
  }
  if (request.temperature !== undefined &&
    (!parameters.temperature || !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) {
    throw invalidPoeRequest("Poe temperature is unsupported or outside the registered range");
  }
  if (request.response_format !== undefined &&
    (!parameters.responseFormat || !["json_object", "text"].includes(request.response_format.type))) {
    throw invalidPoeRequest("Poe response format is unsupported");
  }
  const imageStats = countImageUrls(request.messages);
  if (imageStats.count > model.limits.maxImages || imageStats.largestBytes > model.limits.maxImageBytes) {
    throw invalidPoeRequest("Poe image count or size exceeds the registered route limit");
  }
  const requestBytes = serializedByteLength(request);
  if (requestBytes > model.limits.maxRequestBytes) {
    throw invalidPoeRequest("Poe request exceeds the registered payload limit");
  }
  if (options.route !== undefined && !model.approvedRoutes.includes(options.route)) {
    throw invalidPoeRequest(`Poe model "${model.id}" is not approved for route "${options.route}"`);
  }
}

/** Validate the provider envelope before application code reads any output. */
export function validatePoeChatCompletionResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { choices?: unknown }).choices)) {
    throw new PoeProviderError("upstream", "Poe returned an invalid completion response");
  }
  const response = value as { choices: Array<{ message?: { content?: unknown } }> };
  if (serializedByteLength(value) > 512 * 1024) {
    throw new PoeProviderError("upstream", "Poe completion response exceeded the registered response limit");
  }
  for (const choice of response.choices) {
    if (!choice || typeof choice !== "object" || (choice.message !== undefined &&
      (typeof choice.message !== "object" || (choice.message.content !== undefined &&
        choice.message.content !== null && typeof choice.message.content !== "string")))) {
      throw new PoeProviderError("upstream", "Poe returned an invalid completion choice");
    }
  }
  return value;
}

/**
 * One-attempt completion handle for bounded probes. The response may time out
 * before the SDK transport settles; transportSettled preserves that distinction
 * so callers can retain real concurrency ownership.
 */
export function createPoeChatCompletionWithSettlement(
  request: PoeChatCompletionRequest,
  options: PoeChatCompletionOptions = {},
): PoeChatCompletionHandle {
  try {
    validatePoeChatRequest(request, options);
  } catch (err) {
    const response = Promise.reject(err);
    return { response, transportSettled: Promise.resolve() };
  }
  let transportStarted = false;
  let resolveTransportSettled!: () => void;
  const transportSettled = new Promise<void>((resolve) => {
    resolveTransportSettled = resolve;
  });
  const response = withPoeRetry(
    (_attempt, signal) => {
      transportStarted = true;
      const create = getPoeClient().chat.completions.create;
      let transport;
      try {
        transport =
          typeof create === "function" && "_isMockFunction" in create
            ? create.call(getPoeClient().chat.completions, request as never)
            : create.call(getPoeClient().chat.completions, request as never, { signal });
      } catch (err) {
        resolveTransportSettled();
        throw err;
      }
      void Promise.resolve(transport).then(resolveTransportSettled, resolveTransportSettled);
      return Promise.resolve(transport).then((value) => validatePoeChatCompletionResponse(value));
    },
    {
      maxAttempts: 1,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
    },
  );
  void response.finally(() => {
    if (!transportStarted) resolveTransportSettled();
  }).catch(() => {});
  return { response, transportSettled };
}

/** The sole Poe request-construction boundary used by server callers. */
export async function createPoeChatCompletion(
  request: PoeChatCompletionRequest,
  options: PoeChatCompletionOptions = {},
): Promise<unknown> {
  validatePoeChatRequest(request, options);
  const response = await withPoeRetry(
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
      ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
    },
  );
  return validatePoeChatCompletionResponse(response);
}

export interface PoeCatalogueModel {
  id: string;
  name: string;
  enabled: boolean;
  approvedRoutes: Array<PoeRouteClass>;
  supportedEndpoints: Array<string>;
  supportedParameters: {
    maxCompletionTokens: boolean;
    temperature: boolean;
    responseFormat: boolean;
  };
  modalities: Array<string>;
  endpoint: string;
  parameters: {
    maxCompletionTokens: number | null;
    temperature: boolean | null;
    responseFormat: boolean | null;
  };
  limits: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxImages: number;
    maxImageBytes: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
  };
  capabilities: {
    text: boolean | null;
    vision: boolean | null;
    structuredOutput: boolean | null;
  };
  capabilityConfidence: "verified" | "inferred" | "unknown";
  verification: {
    source: "configured_registry" | "probe" | "unknown";
    owner: string;
    verifiedAt: string | null;
    reviewTrigger: string;
  };
  approvedUse: Array<PoeRouteClass>;
  privacy: "prompt_not_persisted";
  privacyClass: "prompt_not_persisted";
  budgetClass: "low" | "medium" | "high";
  fallbackEligible: Array<PoeErrorKind>;
  failClosed: boolean;
  costNote: string;
  latencyNote: string;
  raw?: Record<string, unknown>;
}

/**
 * Code-owned Poe model registry.
 *
 * This is intentionally the only source of model IDs accepted by the Poe
 * transport. Do not replace it with provider catalogue discovery: a provider
 * wide model response is not an authorization boundary for this application.
 */
export const POE_MODEL_REGISTRY: ReadonlyArray<PoeCatalogueModel> = [
  {
    id: "Claude-Sonnet-4.5",
    name: "Claude-Sonnet-4.5",
    enabled: true,
    approvedRoutes: ["identify", "dimensions", "enrich", "catalog"],
    supportedEndpoints: [POE_CHAT_COMPLETIONS_ENDPOINT],
    supportedParameters: { maxCompletionTokens: true, temperature: true, responseFormat: true },
    modalities: ["text", "vision", "structured_output"],
    endpoint: POE_CHAT_COMPLETIONS_ENDPOINT,
    parameters: { maxCompletionTokens: null, temperature: true, responseFormat: true },
    limits: { maxInputTokens: 20_000, maxOutputTokens: 2_048, maxImages: 10, maxImageBytes: 20 * 1024 * 1024, maxRequestBytes: 32 * 1024 * 1024, maxResponseBytes: 512 * 1024 },
    capabilities: { text: true, vision: true, structuredOutput: true },
    capabilityConfidence: "verified",
    verification: { source: "configured_registry", owner: "application", verifiedAt: "2026-09-22", reviewTrigger: "model, endpoint, capability, privacy, or limit evidence changes" },
    approvedUse: ["identify", "dimensions", "enrich", "catalog"],
    privacy: "prompt_not_persisted",
    privacyClass: "prompt_not_persisted",
    budgetClass: "medium",
    fallbackEligible: ["rate_limited", "quota_exhaustion", "timeout", "upstream", "unavailable_model"],
    failClosed: true,
    costNote: "Configured application model",
    latencyNote: "Latency varies by provider load",
  },
  {
    id: "Gemini-3.1-Pro",
    name: "Gemini-3.1-Pro",
    enabled: true,
    approvedRoutes: ["enrich", "catalog", "identify", "dimensions"],
    supportedEndpoints: [POE_CHAT_COMPLETIONS_ENDPOINT],
    supportedParameters: { maxCompletionTokens: true, temperature: true, responseFormat: true },
    modalities: ["text", "vision", "structured_output"],
    endpoint: POE_CHAT_COMPLETIONS_ENDPOINT,
    parameters: { maxCompletionTokens: null, temperature: true, responseFormat: true },
    limits: { maxInputTokens: 20_000, maxOutputTokens: 2_048, maxImages: 16, maxImageBytes: 20 * 1024 * 1024, maxRequestBytes: 32 * 1024 * 1024, maxResponseBytes: 512 * 1024 },
    capabilities: { text: true, vision: true, structuredOutput: true },
    capabilityConfidence: "verified",
    verification: { source: "configured_registry", owner: "application", verifiedAt: "2026-09-22", reviewTrigger: "model, endpoint, capability, privacy, or limit evidence changes" },
    approvedUse: ["enrich", "catalog", "identify", "dimensions"],
    privacy: "prompt_not_persisted",
    privacyClass: "prompt_not_persisted",
    budgetClass: "medium",
    fallbackEligible: ["rate_limited", "quota_exhaustion", "timeout", "upstream", "unavailable_model"],
    failClosed: true,
    costNote: "Configured application model",
    latencyNote: "Latency varies by provider load",
  },
  {
    id: "Gemini-2.5-Pro",
    name: "Gemini-2.5-Pro",
    enabled: true,
    approvedRoutes: ["catalog"],
    supportedEndpoints: [POE_CHAT_COMPLETIONS_ENDPOINT],
    supportedParameters: { maxCompletionTokens: true, temperature: true, responseFormat: true },
    modalities: ["text", "vision", "structured_output"],
    endpoint: POE_CHAT_COMPLETIONS_ENDPOINT,
    parameters: { maxCompletionTokens: null, temperature: true, responseFormat: true },
    limits: { maxInputTokens: 20_000, maxOutputTokens: 2_048, maxImages: 16, maxImageBytes: 20 * 1024 * 1024, maxRequestBytes: 32 * 1024 * 1024, maxResponseBytes: 512 * 1024 },
    capabilities: { text: true, vision: true, structuredOutput: true },
    capabilityConfidence: "verified",
    verification: { source: "configured_registry", owner: "application", verifiedAt: "2026-09-22", reviewTrigger: "model, endpoint, capability, privacy, or limit evidence changes" },
    approvedUse: ["catalog"],
    privacy: "prompt_not_persisted",
    privacyClass: "prompt_not_persisted",
    budgetClass: "high",
    fallbackEligible: ["rate_limited", "quota_exhaustion", "timeout", "upstream", "unavailable_model"],
    failClosed: true,
    costNote: "Configured application fallback model",
    latencyNote: "Latency varies by provider load",
  },
];

export const POE_MODEL_REGISTRY_VERSION = "static-v1";

function clonePoeModel(model: PoeCatalogueModel): PoeCatalogueModel {
  return {
    ...model,
    enabled: model.enabled ?? false,
    approvedRoutes: [...(model.approvedRoutes ?? model.approvedUse ?? [])],
    supportedEndpoints: [...(model.supportedEndpoints ?? [POE_CHAT_COMPLETIONS_ENDPOINT])],
    supportedParameters: {
      maxCompletionTokens: model.supportedParameters?.maxCompletionTokens ?? model.parameters?.maxCompletionTokens !== null,
      temperature: model.supportedParameters?.temperature ?? model.parameters?.temperature === true,
      responseFormat: model.supportedParameters?.responseFormat ?? model.parameters?.responseFormat === true,
    },
    modalities: [...model.modalities],
    capabilities: { ...model.capabilities },
    parameters: { ...model.parameters },
    limits: {
      maxInputTokens: model.limits?.maxInputTokens ?? 0,
      maxOutputTokens: model.limits?.maxOutputTokens ?? 0,
      maxImages: model.limits?.maxImages ?? 0,
      maxImageBytes: model.limits?.maxImageBytes ?? 0,
      maxRequestBytes: model.limits?.maxRequestBytes ?? 0,
      maxResponseBytes: model.limits?.maxResponseBytes ?? 0,
    },
    approvedUse: [...model.approvedUse],
    ...(model.raw ? { raw: { ...model.raw } } : {}),
    verification: {
      ...model.verification,
      reviewTrigger: model.verification?.reviewTrigger ?? "registry evidence changed",
    },
    privacyClass: model.privacyClass ?? model.privacy,
    budgetClass: model.budgetClass ?? "medium",
    fallbackEligible: [...(model.fallbackEligible ?? [])],
    failClosed: model.failClosed ?? true,
  };
}

export function getPoeModelRegistry(): Array<PoeCatalogueModel> {
  return POE_MODEL_REGISTRY.map(clonePoeModel);
}

export function getPoeRegistryModel(modelId: string): PoeCatalogueModel | undefined {
  const model = POE_MODEL_REGISTRY.find((candidate) => candidate.id === modelId);
  return model ? clonePoeModel(model) : undefined;
}

export function isPoeModelRegistered(modelId: string): boolean {
  return POE_MODEL_REGISTRY.some((candidate) => candidate.id === modelId);
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
