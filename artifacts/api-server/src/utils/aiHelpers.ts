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
    const byteSize = estimateImageBytes(images[i]);
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
 * Extract the first JSON object from an AI response string and parse it.
 * Returns null when no valid JSON object is found, when JSON.parse throws,
 * or when the parsed value is not a plain non-null object (e.g. an array or
 * primitive — which would pass an unchecked `as` cast but fail at use-time).
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed: unknown = JSON.parse(match[0]);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
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
