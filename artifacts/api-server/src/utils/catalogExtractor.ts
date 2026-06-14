/**
 * AI utility: calls GPT-4o to extract catalog entries from a single PDF page.
 * Accepts the page's text content and/or rendered/embedded page images.
 * Returns structured JSON with one entry per part found on the page.
 *
 * Two image-slot strategy per part:
 *   Rendered-page path (pdftoppm): page.images = [one large page PNG]
 *     → imageRegion / imageRegion2 are normalised bounding boxes to crop from that PNG.
 *   Embedded-image path (pdfjs-dist): page.images = [img0, img1, img2, ...]
 *     → imageIndex / imageIndex2 are 0-based indices into that array.
 */

import { getAiClient, getCatalogModel } from "../lib/aiProvider";

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
  /** Primary image crop region on the rendered page (0–1 normalised), or null */
  imageRegion: ImageRegion | null;
  /** Secondary image crop region on the rendered page (0–1 normalised), or null */
  imageRegion2: ImageRegion | null;
  /** Primary image: 0-based index into pageImages[] for embedded-image pages, or -1 */
  imageIndex: number;
  /** Secondary image: 0-based index into pageImages[] for embedded-image pages, or -1 */
  imageIndex2: number;
}

const SYSTEM_PROMPT = `You are an expert electrical supply catalog parser.
Given the text and/or images from a single page of a manufacturer's product catalog, extract all parts listed on the page.
For each part return a JSON object with these 8 fields:
  - catalogNumber: the manufacturer catalog/part number (exact string, no spaces around hyphens)
  - description: short product description (max 200 chars)
  - confidence: how confident you are this is a real part number (0.0–1.0)
  - hasPartImage: boolean — true ONLY if a clearly visible product photograph or illustration appears for this specific part. Set false for text/table-only pages or when uncertain.

For the image fields, choose the right set based on what you see:

IF the image(s) you received show a FULL CATALOG PAGE LAYOUT (one large image with text, tables, and multiple products laid out together):
  - imageRegion: tight normalised bounding box { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 } (0.0–1.0 fractions of page width/height) for the PRIMARY product image for this part. The area (width × height) must be between 0.02 and 0.85. Set null if not found or not confident.
  - imageRegion2: same format for a SECONDARY image of this same part (second angle, package/box shot, wiring diagram, etc.) directly adjacent or associated with it in the layout. Set null if no second image exists.
  - imageIndex: -1
  - imageIndex2: -1

IF the image(s) you received are SEPARATE INDIVIDUAL PRODUCT IMAGES (not a full catalog page — each image is a standalone product photo or illustration):
  - imageIndex: 0-based index of the PRIMARY image for this part among the provided images. Set -1 if none match.
  - imageIndex2: 0-based index of the SECONDARY image for this part (second view, box shot). Set -1 if none.
  - imageRegion: null
  - imageRegion2: null

Return ONLY a JSON array of objects with exactly those 8 fields. No markdown, no explanation.
If no parts are found, return an empty array [].`;

function parseRegion(val: unknown): ImageRegion | null {
  if (!val || typeof val !== "object") return null;
  const r = val as Record<string, unknown>;
  if (
    typeof r["x"] !== "number" ||
    typeof r["y"] !== "number" ||
    typeof r["width"] !== "number" ||
    typeof r["height"] !== "number"
  ) return null;
  return {
    x: Math.max(0, Math.min(1, r["x"] as number)),
    y: Math.max(0, Math.min(1, r["y"] as number)),
    width: Math.max(0, Math.min(1, r["width"] as number)),
    height: Math.max(0, Math.min(1, r["height"] as number)),
  };
}

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
    const response = await getAiClient().chat.completions.create({
      model: getCatalogModel(),
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
        const entry = e as Record<string, unknown>;
        const hasPartImage = !!entry["hasPartImage"];
        const imageRegion = hasPartImage ? parseRegion(entry["imageRegion"]) : null;
        const imageRegion2 = hasPartImage ? parseRegion(entry["imageRegion2"]) : null;
        const imageIndex = typeof entry["imageIndex"] === "number" ? Math.round(entry["imageIndex"]) : -1;
        const imageIndex2 = typeof entry["imageIndex2"] === "number" ? Math.round(entry["imageIndex2"]) : -1;
        return {
          catalogNumber: (entry["catalogNumber"] as string).trim(),
          description: (entry["description"] as string).trim().slice(0, 200),
          confidence: Math.max(0, Math.min(1, entry["confidence"] as number)),
          hasPartImage,
          imageRegion,
          imageRegion2,
          imageIndex,
          imageIndex2,
        };
      });
  } catch (err) {
    console.error("[catalog-extract] GPT-4o error:", err);
    return [];
  }
}
