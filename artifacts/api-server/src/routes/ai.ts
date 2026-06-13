import { Router } from "express";
import { aiClient, IDENTIFY_MODEL } from "../lib/aiProvider";
import { isPoeAuthError, isPoeTransientError, poeErrorMessage } from "@workspace/integrations-poe-server";
import { buildImageContent, extractJsonFromText, normalizeAnalysis } from "../utils/aiHelpers";
import { db } from "@workspace/db";
import { aiRequestLogTable } from "@workspace/db";
import { lt } from "drizzle-orm";
import { logger } from "../lib/logger";
import OpenAI from "openai";

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

    const response = await aiClient.chat.completions.create({
      model: IDENTIFY_MODEL,
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You are an expert electrical supply warehouse specialist. Analyze the provided image(s) and identify the electrical part. Return ONLY valid JSON with these fields: partNumbers (string[]), searchTerms (string[]), synonyms (string[]), relatedTerms (string[]), manufacturerVerified (boolean), detectedVendor (string|null), summary (string). partNumbers must contain ONLY the exact catalog/part numbers you can read directly from the image or label (e.g. [\"CHB5\", \"QO115\"]); leave it empty if no part number is clearly visible. searchTerms should include all descriptive terms, part numbers, manufacturer codes, and alternative names.",
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
      partNumbers: analysis.partNumbers ?? [],
      searchTerms: analysis.searchTerms ?? [],
      synonyms: analysis.synonyms ?? [],
      relatedTerms: analysis.relatedTerms ?? [],
      manufacturerVerified: analysis.manufacturerVerified ?? false,
      detectedVendor: analysis.detectedVendor ?? null,
      summary: analysis.summary ?? "",
      results: [], // Client will run search with these terms
    });

    // Fire-and-forget: log this AI identify request and prune rows older than 90 days
    setImmediate(async () => {
      try {
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        await db.insert(aiRequestLogTable).values({ feature: "identify" });
        await db.delete(aiRequestLogTable).where(lt(aiRequestLogTable.createdAt, ninetyDaysAgo));
      } catch (err) {
        logger.warn({ err }, "ai_request_log insert failed");
      }
    });
  } catch (err) {
    if (isPoeAuthError(err)) {
      logger.error({ err }, "AI auth error in POST /ai/identify");
      return void res.status(401).json({ error: poeErrorMessage(err) });
    }
    if (err instanceof OpenAI.RateLimitError) {
      logger.error({ err }, "AI rate-limit/quota error in POST /ai/identify");
      return void res.status(429).json({ error: poeErrorMessage(err) });
    }
    if (isPoeTransientError(err)) {
      logger.error({ err }, "AI transient error in POST /ai/identify");
      return void res.status(503).json({ error: poeErrorMessage(err) });
    }
    const aiMsg = poeErrorMessage(err);
    if (aiMsg) {
      logger.error({ err }, "AI API error in POST /ai/identify");
      return void res.status(502).json({ error: aiMsg });
    }
    logger.error({ err }, "Unexpected error in POST /ai/identify");
    res.status(500).json({ error: "AI identification failed" });
  }
});

// POST /ai/reference — deprecated alias, forwards to /reference/ask behavior
// Kept for backwards compat; primary route is /reference/ask
router.post("/reference", async (req, res) => {
  res.status(308).json({ message: "Use /api/reference/ask instead" });
});

export default router;
