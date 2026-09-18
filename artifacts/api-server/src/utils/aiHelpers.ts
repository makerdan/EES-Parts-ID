/**
 * Pure helper functions for the AI identification pipeline.
 * Extracted for unit testability — no network or DB dependencies.
 */

/**
 * Default maximum total image payload in bytes before the AI call is rejected.
 * Matches the practical limit most vision providers enforce (~20 MB of raw pixel
 * data encoded as base64).  Can be overridden in tests or via environment config.
 */
export const MAX_IMAGE_PAYLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Estimate the decoded byte size of a single base64 image string (bare or data: URI).
 * Uses the upper-bound formula: ceil(base64Chars * 3 / 4).
 */
export function estimateImageBytes(img: string): number {
  const b64 = img.startsWith("data:") ? (img.split(",")[1] ?? "") : img;
  return Math.ceil((b64.length * 3) / 4);
}

/**
 * Check whether any individual image in the list exceeds `limitBytes`.
 * Use this for models with a strict per-image size cap (e.g. Claude Sonnet: 10 MB).
 *
 * Returns `{ ok: true }` when every image is within the limit, or
 * `{ ok: false, message, imageIndex, byteSize }` for the first oversized image.
 */
export function checkPerImageSize(
  images: Array<string>,
  limitBytes: number,
): { ok: true } | { ok: false; message: string; imageIndex: number; byteSize: number } {
  for (let i = 0; i < images.length; i++) {
    const byteSize = estimateImageBytes(images[i]!);
    if (byteSize > limitBytes) {
      const mb = (byteSize / (1024 * 1024)).toFixed(1);
      const limitMb = (limitBytes / (1024 * 1024)).toFixed(0);
      return {
        ok: false,
        message: `Image ${i + 1} is too large (${mb} MB) — limit is ${limitMb} MB per image. Please use a smaller image.`,
        imageIndex: i,
        byteSize,
      };
    }
  }
  return { ok: true };
}

/**
 * Check whether the combined decoded byte size of a list of base64 image strings
 * exceeds `limitBytes` (defaults to MAX_IMAGE_PAYLOAD_BYTES).
 *
 * Returns `{ ok: true }` when the payload is within the limit, or
 * `{ ok: false, message, byteSize }` with a user-friendly message otherwise.
 *
 * Handles both bare base64 strings and data: URI strings
 * (`data:image/jpeg;base64,<data>`).  The size estimate is an upper bound:
 * `ceil(base64Chars * 3 / 4)`.
 */
export function checkImagePayloadSize(
  images: Array<string>,
  limitBytes: number = MAX_IMAGE_PAYLOAD_BYTES,
): { ok: true } | { ok: false; message: string; byteSize: number } {
  const byteSize = images.reduce((sum, img) => {
    const b64 = img.startsWith("data:") ? (img.split(",")[1] ?? "") : img;
    return sum + Math.ceil((b64.length * 3) / 4);
  }, 0);

  if (byteSize > limitBytes) {
    const mb = (byteSize / (1024 * 1024)).toFixed(1);
    const limitMb = (limitBytes / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      message: `Image payload too large (${mb} MB, limit ${limitMb} MB). Please use smaller or fewer images.`,
      byteSize,
    };
  }
  return { ok: true };
}

export interface AiAnalysis {
  partNumbers: Array<string>;
  searchTerms: Array<string>;
  synonyms: Array<string>;
  relatedTerms: Array<string>;
  manufacturerVerified: boolean;
  detectedVendor: string | null;
  summary: string;
}

/**
 * Convert a list of raw image strings (base64 or data: URIs) into the
 * OpenAI chat message image_url content block format.
 * At most 4 images are used (matching the UI capture limit).
 * Bare base64 strings (no data: prefix) are treated as JPEG.
 */
export function buildImageContent(images: Array<string>): Array<{
  type: "image_url";
  image_url: { url: string };
}> {
  return images.slice(0, 4).map(img => ({
    type: "image_url" as const,
    image_url: {
      url: img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`,
    },
  }));
}

/**
 * Extract the first JSON value from an AI response string and parse it.
 *
 * Scans for the first `{` or `[` and walks the string tracking bracket depth
 * (while respecting string literals and escapes) to isolate exactly that one
 * balanced JSON structure — so trailing prose or a second object doesn't
 * corrupt the parse the way a greedy `.*` match would.
 *
 * Returns null when no bracketed JSON is found, when JSON.parse throws, or
 * when the parsed value is not a plain non-null object (e.g. an array — which
 * would pass an unchecked `as` cast but fail at use-time downstream). This
 * non-object guard is why arrays are rejected even though they parse cleanly.
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract the first balanced JSON object or array from model text.
 *
 * Unlike extractJsonFromText, this helper also permits arrays, which are used
 * by catalogue extraction. It still rejects primitive JSON values so a model
 * response cannot accidentally satisfy an object-shaped contract.
 */
export function extractJsonValueFromText(text: string): Record<string, unknown> | Array<unknown> | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown> | Array<unknown>;
  } catch {
    return null;
  }
}

interface RuntimeSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: unknown };
}

export class MalformedAiResponseError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`AI response did not match the expected ${feature} format`);
    this.name = "MalformedAiResponseError";
    this.feature = feature;
  }
}

/**
 * Validate model-generated JSON at the shared runtime boundary.
 *
 * Callers that have an established safe fallback may use the fallback
 * overload. Persistence-oriented callers should use parseAiResponse directly
 * so malformed output becomes an error before any write is attempted.
 */
export function parseAiResponse<T>(
  rawText: string,
  schema: RuntimeSchema<T>,
  feature: string,
): T {
  const result = schema.safeParse(extractJsonValueFromText(rawText));
  if (!result.success) throw new MalformedAiResponseError(feature);
  return result.data;
}

export function parseAiResponseOr<T>(
  rawText: string,
  schema: RuntimeSchema<T>,
  feature: string,
  fallback: T,
): T {
  try {
    return parseAiResponse(rawText, schema, feature);
  } catch (err) {
    if (!(err instanceof MalformedAiResponseError)) throw err;
    return fallback;
  }
}

/**
 * Normalize a raw AI analysis object into a fully-typed AiAnalysis,
 * providing safe defaults for every field.
 * When `parsed` is null (AI returned non-JSON prose), search terms are left
 * empty so the caller skips the inventory search; the raw text is kept as the
 * summary so the user sees what the AI said instead of garbage results.
 */
/**
 * Returns true when an error thrown by an AI provider indicates the request
 * body was too large (HTTP 413 or a provider-specific "payload too large"
 * message).  Used to translate opaque provider errors into a clear 413
 * response before they fall through to the generic 500 handler.
 */
export function isProviderPayloadTooLargeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; message?: string; code?: string };
  if (e.status === 413) return true;
  const msg = (e.message ?? "").toLowerCase();
  const code = (e.code ?? "").toLowerCase();
  return (
    msg.includes("too large") ||
    (msg.includes("payload") && msg.includes("large")) ||
    (msg.includes("image") && msg.includes("size")) ||
    msg.includes("413") ||
    code === "request_too_large" ||
    code === "payload_too_large" ||
    code === "image_too_large"
  );
}

export function normalizeAnalysis(
  parsed: Record<string, unknown> | null,
  rawText: string,
): AiAnalysis {
  if (!parsed) {
    return {
      partNumbers: [],
      searchTerms: [],
      synonyms: [],
      relatedTerms: [],
      manufacturerVerified: false,
      detectedVendor: null,
      summary: rawText.slice(0, 200),
    };
  }
  return {
    partNumbers: Array.isArray(parsed.partNumbers) ? (parsed.partNumbers as Array<string>) : [],
    searchTerms: Array.isArray(parsed.searchTerms) ? (parsed.searchTerms as Array<string>) : [],
    synonyms: Array.isArray(parsed.synonyms) ? (parsed.synonyms as Array<string>) : [],
    relatedTerms: Array.isArray(parsed.relatedTerms) ? (parsed.relatedTerms as Array<string>) : [],
    manufacturerVerified: typeof parsed.manufacturerVerified === "boolean"
      ? parsed.manufacturerVerified
      : false,
    detectedVendor: typeof parsed.detectedVendor === "string"
      ? parsed.detectedVendor
      : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}
