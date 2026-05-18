/**
 * AI utility: calls GPT-4o to extract catalog entries from a single PDF page.
 * Accepts the page's text content and up to 4 embedded images.
 * Returns structured JSON with one entry per part found on the page.
 */

import { openai } from "@workspace/integrations-openai-ai-server";

export interface CatalogEntry {
  catalogNumber: string;
  description: string;
  confidence: number;
  hasPartImage: boolean;
  /** 0-based index into the page images array, or null */
  imageIndex: number | null;
}

const SYSTEM_PROMPT = `You are an expert electrical supply catalog parser.
Given the text and/or images from a single page of a manufacturer's product catalog, extract all parts listed on the page.
For each part return a JSON object with:
  - catalogNumber: the manufacturer catalog/part number (exact string, no spaces around hyphens)
  - description: short product description (max 200 chars)
  - confidence: how confident you are this is a real part number (0.0–1.0)
  - hasPartImage: boolean — true if there is a product photo associated with this part
  - imageIndex: if hasPartImage is true, the 0-based index of the image in the provided images array that best shows this part; otherwise null

Return ONLY a JSON array of objects with exactly those 5 fields. No markdown, no explanation.
If no parts are found, return an empty array [].`;

export async function extractCatalogPage(
  pageText: string,
  pageImages: Buffer[],
  vendor: string,
): Promise<CatalogEntry[]> {
  if (!pageText.trim() && pageImages.length === 0) return [];

  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];

  if (pageText.trim()) {
    userContent.push({
      type: "text",
      text: `Vendor: ${vendor}\nPage text:\n${pageText.slice(0, 3000)}`,
    });
  }

  // Include up to 4 images from the page
  const imagesToSend = pageImages.slice(0, 4);
  for (const imgBuf of imagesToSend) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${imgBuf.toString("base64")}` },
    });
  }

  if (userContent.length === 0) return [];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "[]";
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((e): e is CatalogEntry => {
        const entry = e as Partial<CatalogEntry>;
        return (
          typeof entry.catalogNumber === "string" &&
          entry.catalogNumber.trim().length > 0 &&
          typeof entry.description === "string" &&
          typeof entry.confidence === "number"
        );
      })
      .map((e) => ({
        catalogNumber: e.catalogNumber.trim(),
        description: e.description.trim().slice(0, 200),
        confidence: Math.max(0, Math.min(1, e.confidence)),
        hasPartImage: !!e.hasPartImage,
        imageIndex: typeof e.imageIndex === "number" ? e.imageIndex : null,
      }));
  } catch (err) {
    console.error("[catalog-extract] GPT-4o error:", err);
    return [];
  }
}
