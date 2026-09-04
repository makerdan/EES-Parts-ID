import OpenAI from "openai";

let _poeClient: OpenAI | null = null;

export const POE_BASE_URL = "https://api.poe.com/v1";
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
  | "rate_limit"
  | "timeout"
  | "network"
  | "not_found"
  | "server"
  | "malformed"
  | "unknown";

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Classify provider failures once at the transport boundary. Callers should
 * use this vocabulary rather than inspecting SDK classes or status codes.
 */
export function classifyPoeError(err: unknown): PoeErrorKind {
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
  if (is("RateLimitError") || statusOf(err) === 429) {
    return "rate_limit";
  }
  if (
    is("APIConnectionTimeoutError") ||
    (err instanceof Error && err.name === "AbortError")
  ) {
    return "timeout";
  }
  if (is("APIConnectionError")) return "network";
  if (is("NotFoundError") || statusOf(err) === 404) {
    return "not_found";
  }
  if (is("InternalServerError") || (statusOf(err) ?? 0) >= 500) {
    return "server";
  }
  if (err instanceof SyntaxError) return "malformed";
  return "unknown";
}

export async function withPoeRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = POE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error(`Poe request timed out after ${timeoutMs}ms`);
        error.name = "AbortError";
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PoeCatalogueModel {
  id: string;
  name: string;
  modalities: Array<string>;
  capabilities: {
    text: boolean | null;
    vision: boolean | null;
    structuredOutput: boolean | null;
  };
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

  return {
    id: id || name,
    name: name || id,
    modalities: [...new Set(modalities)],
    capabilities: { text, vision, structuredOutput },
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
  const kind = classifyPoeError(err);
  return kind === "rate_limit" || kind === "server" || kind === "network" || kind === "timeout";
}

/**
 * Returns a human-readable message for a known Poe API error,
 * or null if the error is not a recognised Poe API error.
 */
export function poeErrorMessage(err: unknown): string | null {
  const kind = classifyPoeError(err);
  if (kind === "authentication") {
    return "Poe API key is invalid or has been revoked. Check the POE_API_KEY2 secret.";
  }
  if (kind === "permission") {
    return "Poe API key does not have access to the requested bot. Check your Poe subscription or bot permissions.";
  }
  if (kind === "rate_limit") {
    return "Poe API rate limit or quota exceeded. Try again later or reduce concurrency.";
  }
  if (kind === "not_found") {
    return "Poe bot not found. Check the model name is correct.";
  }
  if (err instanceof OpenAI.APIError) {
    return `Poe API error (HTTP ${err.status}): ${err.message}`;
  }
  return null;
}
