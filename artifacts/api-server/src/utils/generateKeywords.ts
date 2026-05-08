/**
 * Shared utility for AI keyword generation.
 * Encapsulates the OpenAI call and keyword parsing used by:
 *  - POST /inventory/enrich (SSE per-batch endpoint)
 *  - runBulkEnrich background job
 *  - src/seed/bulk-enrich.ts standalone script
 */

import { openai } from '@workspace/integrations-openai-ai-server';

export interface EnrichItem {
  vendor: string;
  catalog: string;
  description: string | null;
}

const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Junk values that the AI occasionally returns instead of real keywords.
 * Checked case-insensitively after trimming whitespace.
 */
const JUNK_KEYWORD_PATTERNS = new Set([
  'n/a',
  'na',
  'n.a.',
  'n.a',
  'null',
  'none',
  'nil',
  'undefined',
  'unknown',
  '-',
  '--',
  '---',
  'true',
  'false',
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

/**
 * Call OpenAI to generate searchable keywords for an inventory item.
 * Returns an array of up to 10 keyword strings, with junk values removed.
 *
 * @param item       - The inventory item to generate keywords for.
 * @param model      - The OpenAI model to use (defaults to gpt-4o-mini).
 * @param tradeSize  - Optional canonical trade-size label (e.g. `1/2"`).
 *                     When provided it is included in the prompt so the AI
 *                     can generate more specific size variants.
 */
export async function generateKeywords(
  item: EnrichItem,
  model: string = DEFAULT_MODEL,
  tradeSize?: string
): Promise<string[]> {
  const tradeSizeLine = tradeSize ? `\nTrade size: ${tradeSize}` : '';
  const response = await openai.chat.completions.create(
    {
      model,
      max_completion_tokens: 256,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert electrical supply warehouse cataloger. Generate searchable keywords for electrical parts. Return ONLY a JSON array of 6-10 keyword strings. Include: full product name, category, common synonyms, abbreviation expansions, material, ratings, NEMA type if applicable. No explanations.',
        },
        {
          role: 'user',
          content: `Vendor: ${item.vendor}\nCatalog: ${item.catalog}\nDescription: ${item.description ?? ''}${tradeSizeLine}\n\nReturn JSON array of keywords only.`,
        },
      ],
      // Abort if OpenAI doesn't respond within 30 s — prevents a slow/hung
      // response from blocking the enrichment worker indefinitely.
    },
    { timeout: 30_000 }
  );

  const text = response.choices[0]?.message?.content ?? '[]';
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? '[]');
    if (Array.isArray(parsed)) keywords = parsed.map(String).slice(0, 10);
  } catch {
    keywords = text
      .split(/[,\n]/)
      .map((k: string) => k.trim().replace(/["\[\]]/g, ''))
      .filter((k: string) => k.length > 1)
      .slice(0, 10);
  }
  return keywords.filter((k) => !isJunkKeyword(k));
}
