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
 * At most 2 images are used to stay within token/context limits.
 * Bare base64 strings (no data: prefix) are treated as JPEG.
 */
export function buildImageContent(images: string[]): Array<{
  type: "image_url";
  image_url: { url: string };
}> {
  return images.slice(0, 2).map(img => ({
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
 * Falls back to splitting the raw text into word tokens when `parsed` is null.
 */
export function normalizeAnalysis(
  parsed: Record<string, unknown> | null,
  rawText: string,
): AiAnalysis {
  if (!parsed) {
    return {
      partNumbers: [],
      searchTerms: rawText.split(/\s+/).slice(0, 10),
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
