/**
 * Shared utility for AI description suggestion.
 *
 * Produces a single 1–2 sentence improved description for an inventory
 * item by folding the most important AI keywords into natural prose
 * while preserving any specifics already in the existing description.
 *
 * The intent is to push the *primary* search signal (full product
 * wording, ratings, materials, slang/abbreviations the worker actually
 * types) into the description field, since description carries more
 * weight in the search ranker than keywords do.
 */

import { openai } from '@workspace/integrations-openai-ai-server';

export interface SuggestDescriptionInput {
  vendor: string;
  catalog: string;
  description: string | null;
  keywords: string[];
}

const DEFAULT_MODEL = 'gpt-4o-mini';

/** Maximum characters of suggested description we accept from the model. */
const MAX_DESCRIPTION_LENGTH = 240;

/**
 * Ask OpenAI to produce one improved description (1–2 sentences) that
 * merges the existing description with the provided keywords.
 *
 * Always returns a non-empty string. Throws if the OpenAI call itself
 * fails or if the model returns nothing usable.
 */
export async function suggestDescription(
  item: SuggestDescriptionInput,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const existingDesc = (item.description ?? '').trim();
  const keywordList = item.keywords.filter((k) => k.trim().length > 0);

  const response = await openai.chat.completions.create(
    {
      model,
      max_completion_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert electrical supply warehouse cataloger. ' +
            "Rewrite the part's DESCRIPTION so it reads as 1–2 natural English " +
            'sentences (no bullet lists, no headers). The description is the ' +
            'primary search signal — fold the most important keywords into ' +
            'the prose: full product wording, ratings, voltage/amperage, ' +
            'materials, NEMA/IP type, color. Preserve every concrete spec ' +
            'already present in the existing description (do not drop part ' +
            'numbers, sizes, or ratings). Keep it under 240 characters. ' +
            'Return ONLY the new description text — no JSON, no quotes, no ' +
            "explanation, no leading 'Description:' label.",
        },
        {
          role: 'user',
          content:
            `Vendor: ${item.vendor}\n` +
            `Catalog: ${item.catalog}\n` +
            `Existing description: ${existingDesc || '(none)'}\n` +
            `AI keywords: ${keywordList.join(', ') || '(none)'}\n\n` +
            `Return the improved description as plain text.`,
        },
      ],
      // Abort if OpenAI doesn't respond within 20 s — keeps the editor
      // responsive when the model is slow or hung.
    },
    { timeout: 20_000 }
  );

  const raw = response.choices[0]?.message?.content ?? '';
  const cleaned = cleanSuggestion(raw);
  if (!cleaned) {
    throw new Error('AI returned an empty description');
  }
  return cleaned.length > MAX_DESCRIPTION_LENGTH
    ? cleaned.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()
    : cleaned;
}

/**
 * Strip wrapping quotes / markdown fences / leading "Description:" labels
 * the model occasionally adds despite the system prompt.
 */
function cleanSuggestion(text: string): string {
  let t = text.trim();
  // Strip ```...``` code fences if present
  t = t
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  // Strip leading "Description:" / "Description -" labels
  t = t.replace(/^description\s*[:\-—]\s*/i, '').trim();
  // Strip wrapping single or double quotes
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}
