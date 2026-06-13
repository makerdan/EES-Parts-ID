/**
 * Shared utility for AI keyword generation.
 * Encapsulates the OpenAI call and keyword parsing used by:
 *  - POST /inventory/enrich (SSE per-batch endpoint)
 *  - runBulkEnrich background job
 *  - src/seed/bulk-enrich.ts standalone script
 */

import { aiClient, ENRICH_MODEL } from "../lib/aiProvider";
import { isPoeAuthError, isPoeTransientError, poeErrorMessage } from "@workspace/integrations-poe-server";

export interface EnrichItem {
  vendor: string;
  catalog: string;
  description: string | null;
}

/**
 * Junk values that the AI occasionally returns instead of real keywords.
 * Checked case-insensitively after trimming whitespace.
 */
const JUNK_KEYWORD_PATTERNS = new Set([
  "n/a", "na", "n.a.", "n.a", "null", "none", "nil",
  "undefined", "unknown", "-", "--", "---", "true", "false",
]);

/**
 * Returns true if a keyword string is a placeholder / junk value that
 * should be excluded from saved ai_keywords arrays.
 */
export function isJunkKeyword(kw: string): boolean {
  const t = kw.trim();
  if (t.length <= 1) return true;
  return JUNK_KEYWORD_PATTERNS.has(t.toLowerCase());
}

/** Shape of the enriched error thrown when an AI API call fails. */
export interface PoeEnrichedError extends Error {
  /** True when the key is invalid/revoked or bot access is denied. */
  isPoeAuth: boolean;
  /**
   * True when the error is transient (rate limit, server error, timeout).
   * False for permanent errors (auth, bot not found, bad request, etc.).
   */
  isPoeTransient: boolean;
  /** The original API error. */
  cause: unknown;
}

/**
 * Call the AI provider to generate searchable keywords for an inventory item.
 * Returns an array of up to 10 keyword strings, with junk values removed.
 *
 * Throws a {@link PoeEnrichedError} when an API error is detected so callers
 * can distinguish:
 *  - `isPoeAuth === true`      → fatal; stop immediately, fix the API key
 *  - `isPoeTransient === true` → worth retrying after backoff
 *  - both false                → permanent non-auth error (bad model name, etc.); don't retry
 *
 * @param item   - The inventory item to generate keywords for.
 * @param model  - The AI model/bot to use (defaults to provider default).
 */
export async function generateKeywords(
  item: EnrichItem,
  model: string = ENRICH_MODEL,
): Promise<string[]> {
  let response;
  try {
    response = await aiClient.chat.completions.create({
      model,
      max_completion_tokens: 256,
      messages: [
        {
          role: "system",
          content:
            "You are an expert electrical supply warehouse cataloger. Generate searchable keywords for electrical parts. Return ONLY a JSON array of 6-10 keyword strings. Include: full product name, category, common synonyms, abbreviation expansions, material, ratings, NEMA type if applicable. No explanations.",
        },
        {
          role: "user",
          content: `Vendor: ${item.vendor}\nCatalog: ${item.catalog}\nDescription: ${item.description ?? ""}\n\nReturn JSON array of keywords only.`,
        },
      ],
    });
  } catch (err) {
    const msg = poeErrorMessage(err);
    if (msg) {
      const enriched = new Error(msg) as PoeEnrichedError;
      enriched.isPoeAuth = isPoeAuthError(err);
      enriched.isPoeTransient = isPoeTransientError(err);
      enriched.cause = err;
      throw enriched;
    }
    throw err;
  }

  const text = response.choices[0]?.message?.content ?? "[]";
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    if (Array.isArray(parsed)) keywords = parsed.map(String).slice(0, 10);
  } catch {
    keywords = text
      .split(/[,\n]/)
      .map((k: string) => k.trim().replace(/["\[\]]/g, ""))
      .filter((k: string) => k.length > 1)
      .slice(0, 10);
  }
  return keywords.filter((k) => !isJunkKeyword(k));
}
