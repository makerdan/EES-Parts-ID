/**
 * AI fallback for the taxonomy classifier.
 *
 * Used by POST /categories/classify (and the inventory alias) when the
 * deterministic rule engine in `taxonomyClassifier.ts` can't place an
 * item. Sends a small batch of items + the list of valid leaf slugs to
 * gpt-4o-mini and asks it to pick the best slug per item.
 *
 * Design notes:
 *  • Batched (default 25 / call) to keep latency + token cost bounded.
 *  • Strict JSON output ({ assignments: [{ id, slug }] }) — anything we
 *    can't parse is dropped to Uncategorized by the caller.
 *  • Slug is validated against the supplied allow-list before returning,
 *    so an AI hallucination can't corrupt the DB.
 *  • 30 s timeout per batch; failures bubble up as `null` so the pipeline
 *    keeps making progress instead of hanging.
 */

import { openai } from "@workspace/integrations-openai-ai-server";

export interface AiClassifyItem {
  id: number;
  vendor: string;
  catalog: string;
  description: string;
  aiKeywords: string[];
}

export interface AiClassifyAllowed {
  slug: string;
  name: string;
  parentName: string;
  grandparentName: string;
}

export interface AiClassifyAssignment {
  id: number;
  slug: string;
  confidence: number;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const SYSTEM_PROMPT = `You are an expert electrical-supply warehouse cataloger.
You will be given a list of inventory items and a list of valid taxonomy leaf
slugs. For each item, pick the SINGLE best slug from the list — never invent
a new one. Return STRICT JSON of the shape:
  { "assignments": [ { "id": <number>, "slug": "<one of the allowed slugs>" } ] }
Do not include any item you can't confidently classify.`;

/**
 * Classify up to ~25 inventory items in one call. Returns parsed assignments,
 * filtered to the allowed slug set. Returns [] on any failure.
 */
export async function aiClassifyBatch(
  items: AiClassifyItem[],
  allowed: AiClassifyAllowed[],
  model: string = DEFAULT_MODEL,
): Promise<AiClassifyAssignment[]> {
  if (items.length === 0 || allowed.length === 0) return [];

  const allowedList = allowed
    .map(a => `- ${a.slug} (${a.grandparentName} › ${a.parentName} › ${a.name})`)
    .join("\n");

  const itemsList = items
    .map(it => {
      const kw = it.aiKeywords.length > 0 ? ` | keywords: ${it.aiKeywords.slice(0, 8).join(", ")}` : "";
      return `id=${it.id} | ${it.vendor} ${it.catalog} — ${it.description}${kw}`;
    })
    .join("\n");

  try {
    const response = await openai.chat.completions.create(
      {
        model,
        max_completion_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Allowed slugs (Category › Subcategory › Type):\n${allowedList}\n\n` +
              `Items to classify:\n${itemsList}\n\n` +
              `Return JSON: {"assignments":[{"id":N,"slug":"..."}]}`,
          },
        ],
      },
      { timeout: 30_000 },
    );

    const text = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text) as { assignments?: Array<{ id?: unknown; slug?: unknown }> };
    if (!Array.isArray(parsed.assignments)) return [];

    const allowedSlugs = new Set(allowed.map(a => a.slug));
    const out: AiClassifyAssignment[] = [];
    for (const a of parsed.assignments) {
      const id = Number(a.id);
      const slug = String(a.slug ?? "");
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!allowedSlugs.has(slug)) continue;
      out.push({ id, slug, confidence: 0.7 });
    }
    return out;
  } catch (err) {
    console.warn("[aiClassifyBatch] failed:", err);
    return [];
  }
}
