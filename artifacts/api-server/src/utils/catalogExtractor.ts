/**
 * AI utility: calls GPT-4o to extract catalog entries from a single PDF page.
 * Accepts the page's text content and/or rendered/embedded page images.
 * Returns structured JSON with one entry per part found on the page.
 *
 * imageRegion (when set) is a normalised bounding box [0–1] representing the
 * location of the part image on the page: { x, y, width, height }.
 * It is null when the extraction is text-only (no page rendering available).
 */

import { openai } from "@workspace/integrations-openai-ai-server";

export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CatalogEntry {
  catalogNumber: string;
  description: string;
  confidence: number;
  hasPartImage: boolean;
  /** Normalised bounding box of the part image on the page, or null */
  imageRegion: ImageRegion | null;
}

const SYSTEM_PROMPT = `You are an expert electrical supply catalog parser.
Given the text and/or images from a single page of a manufacturer's product catalog, extract all parts listed on the page.
For each part return a JSON object with:
  - catalogNumber: the manufacturer catalog/part number (exact string, no spaces around hyphens)
  - description: short product description (max 200 chars)
  - confidence: how confident you are this is a real part number (0.0–1.0)
  - hasPartImage: boolean — true if there is a product photo associated with this part on this page
  - imageRegion: if hasPartImage is true, a normalised bounding box object { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 } (values 0–1 as fraction of page dimensions) describing where the part image appears; otherwise null

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

  // Include up to 4 images from the page (rendered page image or embedded images)
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
      .filter((e): e is Record<string, unknown> => {
        const entry = e as Partial<CatalogEntry>;
        return (
          typeof entry.catalogNumber === "string" &&
          entry.catalogNumber.trim().length > 0 &&
          typeof entry.description === "string" &&
          typeof entry.confidence === "number"
        );
      })
      .map((e) => {
        const entry = e as Partial<CatalogEntry> & { imageRegion?: unknown };
        let imageRegion: ImageRegion | null = null;
        if (entry.hasPartImage && entry.imageRegion && typeof entry.imageRegion === "object") {
          const r = entry.imageRegion as unknown as Record<string, unknown>;
          if (
            typeof r["x"] === "number" &&
            typeof r["y"] === "number" &&
            typeof r["width"] === "number" &&
            typeof r["height"] === "number"
          ) {
            imageRegion = {
              x: Math.max(0, Math.min(1, r["x"] as number)),
              y: Math.max(0, Math.min(1, r["y"] as number)),
              width: Math.max(0, Math.min(1, r["width"] as number)),
              height: Math.max(0, Math.min(1, r["height"] as number)),
            };
          }
        }
        return {
          catalogNumber: (entry.catalogNumber as string).trim(),
          description: (entry.description as string).trim().slice(0, 200),
          confidence: Math.max(0, Math.min(1, entry.confidence as number)),
          hasPartImage: !!entry.hasPartImage,
          imageRegion,
        };
      });
  } catch (err) {
    console.error("[catalog-extract] GPT-4o error:", err);
    return [];
  }
}
