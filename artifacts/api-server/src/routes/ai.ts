import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { buildImageContent, extractJsonFromText, normalizeAnalysis } from "../utils/aiHelpers";

const router = Router();

// POST /ai/identify
router.post("/identify", async (req, res) => {
  try {
    const {
      images = [],
      keywords = "",
      vendor = "",
      color = "",
      size = "",
      material = "",
      textNumbers = "",
    } = req.body as {
      images?: string[];
      keywords?: string;
      vendor?: string;
      color?: string;
      size?: string;
      material?: string;
      textNumbers?: string;
    };

    if (!images.length) {
      return void res.status(400).json({ error: "At least one image is required" });
    }

    const contextParts: string[] = [];
    if (keywords) contextParts.push(`Keywords: ${keywords}`);
    if (vendor) contextParts.push(`Manufacturer/Vendor: ${vendor}`);
    if (color) contextParts.push(`Color: ${color}`);
    if (size) contextParts.push(`Size: ${size}`);
    if (material) contextParts.push(`Material: ${material}`);
    if (textNumbers) contextParts.push(`Text/Numbers visible: ${textNumbers}`);
    const contextStr = contextParts.join("\n");

    const imageContent = buildImageContent(images);

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You are an expert electrical supply warehouse specialist. Analyze the provided image(s) and identify the electrical part. Return ONLY valid JSON with these fields: searchTerms (string[]), synonyms (string[]), relatedTerms (string[]), manufacturerVerified (boolean), detectedVendor (string|null), summary (string). Include all possible catalog terms, part numbers visible in images, manufacturer codes, and alternative names.",
        },
        {
          role: "user",
          content: [
            ...imageContent,
            {
              type: "text" as const,
              text: contextStr
                ? `Identify this electrical part. Additional context:\n${contextStr}\n\nReturn JSON only.`
                : "Identify this electrical part. Return JSON only.",
            },
          ],
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "{}";
    const analysis = normalizeAnalysis(extractJsonFromText(text), text);

    res.json({
      searchTerms: analysis.searchTerms ?? [],
      synonyms: analysis.synonyms ?? [],
      relatedTerms: analysis.relatedTerms ?? [],
      manufacturerVerified: analysis.manufacturerVerified ?? false,
      detectedVendor: analysis.detectedVendor ?? null,
      summary: analysis.summary ?? "",
      results: [], // Client will run search with these terms
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI identification failed" });
  }
});

// POST /ai/reference — deprecated alias, forwards to /reference/ask behavior
// Kept for backwards compat; primary route is /reference/ask
router.post("/reference", async (req, res) => {
  res.status(308).json({ message: "Use /api/reference/ask instead" });
});

export default router;
