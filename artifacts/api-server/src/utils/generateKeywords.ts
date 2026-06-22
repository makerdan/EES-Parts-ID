/**
 * Shared utility for AI keyword generation.
 * Encapsulates the OpenAI call and keyword parsing used by:
 *  - POST /inventory/enrich (SSE per-batch endpoint)
 *  - runBulkEnrich background job
 *  - src/seed/bulk-enrich.ts standalone script
 */

import { getEnrichModel } from "../lib/aiProvider";
import {
  callPoeBotWithChain,
  isPoeCallAuthError,
  isPoeCallTransientError,
} from "../lib/poeBot";

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
 * Uses the per-feature Poe fallback chain when the active provider is "poe".
 * The `model` parameter is kept for backwards-compat but is ignored — the
 * chain determines which bot(s) to try.
 *
 * @param item   - The inventory item to generate keywords for.
 * @param model  - Ignored (kept for backwards-compat); the chain picks the bot.
 */
export async function generateKeywords(
  item: EnrichItem,
  model: string = getEnrichModel(),
): Promise<string[]> {
  void model;
  const systemInstruction =
    "You are an electrical supplies identifier and warehouse cataloger specializing in keyword extraction for searchable inventory systems. " +
    "Given a catalog item from an electrical supply distributor, return ONLY a JSON array of 6-10 short keyword strings that maximize searchability. " +
    "Rules:\n" +
    "- Expand all abbreviations and jargon into plain-language equivalents and include BOTH the short form and the expanded form as separate keywords (e.g., 'EMT' and 'electrical metallic tubing'; 'XFMR' and 'transformer'; '3PH' and 'three-phase'; 'AWG' and 'American Wire Gauge'; 'NEMA' with the specific type number if present).\n" +
    "- Include the product category (e.g., 'circuit breaker', 'conduit', 'wire connector', 'luminaire', 'panelboard').\n" +
    "- Include all electrical ratings present or inferable: voltage (e.g., '120V', '480V'), amperage (e.g., '20A', '100A'), phase ('single-phase', 'three-phase'), frequency ('60Hz'), and wattage/kVA where applicable.\n" +
    "- Include material and finish where relevant (e.g., 'galvanized steel', 'PVC', 'aluminum', 'copper').\n" +
    "- Include mounting type, enclosure type, or form factor if present (e.g., 'surface mount', 'weatherproof', 'NEMA 4X', 'flush mount', 'panel mount').\n" +
    "- Include common trade synonyms and slang used by electricians (e.g., 'Romex' for NM-B cable, 'Greenfield' for flexible metal conduit, 'pigtail', 'mud ring').\n" +
    "- Include the manufacturer brand name if identifiable from the vendor code or description.\n" +
    "- Do NOT include junk values, generic filler words, or repeat the same concept twice unless both forms (abbreviated and expanded) are genuinely distinct search terms.\n" +
    "- Output ONLY a raw JSON array of strings. No explanation, no markdown, no wrapping object.";

  const userMessage = `Vendor: ${item.vendor}\nCatalog: ${item.catalog}\nDescription: ${item.description ?? ""}\n\nReturn JSON array of keywords only.`;

  let text: string;
  try {
    text = await callPoeBotWithChain("enrich", systemInstruction, userMessage);
  } catch (err) {
    const enriched = new Error(String(err)) as PoeEnrichedError;
    enriched.isPoeAuth = isPoeCallAuthError(err);
    enriched.isPoeTransient = isPoeCallTransientError(err);
    enriched.cause = err;
    throw enriched;
  }
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
