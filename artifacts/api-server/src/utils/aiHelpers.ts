/**
 * Pure helper functions for the AI identification pipeline.
 * Extracted for unit testability — no network or DB dependencies.
 */

export interface AiAnalysis {
  partNumbers: string[];
  searchTerms: string[];
  synonyms: string[];
  relatedTerms: string[];
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
export function buildImageContent(images: string[]): Array<{
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
 * Returns null when no valid JSON object is found or when JSON.parse throws.
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as Record<string, unknown>;
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
    partNumbers: Array.isArray(parsed.partNumbers) ? (parsed.partNumbers as string[]) : [],
    searchTerms: Array.isArray(parsed.searchTerms) ? (parsed.searchTerms as string[]) : [],
    synonyms: Array.isArray(parsed.synonyms) ? (parsed.synonyms as string[]) : [],
    relatedTerms: Array.isArray(parsed.relatedTerms) ? (parsed.relatedTerms as string[]) : [],
    manufacturerVerified: typeof parsed.manufacturerVerified === "boolean"
      ? parsed.manufacturerVerified
      : false,
    detectedVendor: typeof parsed.detectedVendor === "string"
      ? parsed.detectedVendor
      : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}
