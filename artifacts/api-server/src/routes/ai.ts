import { Router } from "express";
import { aiClient, IDENTIFY_MODEL, ENRICH_MODEL } from "../lib/aiProvider";
import { isPoeAuthError, isPoeTransientError, poeErrorMessage } from "@workspace/integrations-poe-server";
import { buildImageContent, extractJsonFromText, normalizeAnalysis } from "../utils/aiHelpers";
import { db } from "@workspace/db";
import { aiRequestLogTable, inventoryTable, inventoryFtsVector } from "@workspace/db";
import { lt, sql } from "drizzle-orm";
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

// POST /ai/translate-query
// Translates a plain-language parts query into catalog vocabulary.
// When zeroResults=true, also identifies the part and finds substitute inventory matches.
router.post("/translate-query", async (req, res) => {
  try {
    const { query = "", zeroResults = false } = req.body as {
      query?: string;
      zeroResults?: boolean;
    };

    if (!query.trim()) {
      return void res.status(400).json({ error: "query is required" });
    }

    const zeroResultsFields = zeroResults
      ? [
          "- partName: string — the common name for this type of part",
          "- partSpecs: string[] — 3–5 key specifications or characteristics",
          "- catalogNumbers: string[] — 1–3 typical catalog/part numbers from general web knowledge (not the warehouse)",
          "- suggestedRequery: string — the best short search string to find this in an inventory",
        ].join("\n")
      : "";

    const systemContent = [
      "You are an expert electrical supply warehouse assistant.",
      "Translate plain-language part queries into proper electrical catalog vocabulary.",
      "Return ONLY valid JSON with these fields:",
      '- translatedTerms: string[] — 2–5 catalog search keywords (e.g. ["GFCI receptacle","20A","NEMA 5-20R"])',
      '- interpretation: string — brief human-readable explanation (e.g. "A weatherproof GFCI outlet rated 20A")',
      "- appliedTranslation: boolean — true when the query was plain language needing translation; false when already catalog vocabulary (part numbers, acronyms, known codes like BR120 or THHN)",
      zeroResultsFields,
    ].filter(Boolean).join("\n");

    const userContent = zeroResults
      ? `The user searched for "${query.trim()}" and found ZERO results in inventory. Identify the part and translate the query. Return JSON only.`
      : `Translate this warehouse parts query into catalog vocabulary: "${query.trim()}". Return JSON only.`;

    const response = await aiClient.chat.completions.create({
      model: ENRICH_MODEL,
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userContent },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "{}";
    const parsed = extractJsonFromText(text) ?? {};

    const translatedTerms = Array.isArray(parsed.translatedTerms)
      ? (parsed.translatedTerms as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 8)
      : [];
    const interpretation = typeof parsed.interpretation === "string" ? parsed.interpretation : "";
    const appliedTranslation =
      typeof parsed.appliedTranslation === "boolean" ? parsed.appliedTranslation : translatedTerms.length > 0;

    if (!zeroResults) {
      return void res.json({ translatedTerms, interpretation, appliedTranslation });
    }

    const partName = typeof parsed.partName === "string" ? parsed.partName : "";
    const partSpecs = Array.isArray(parsed.partSpecs)
      ? (parsed.partSpecs as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 6)
      : [];
    const catalogNumbers = Array.isArray(parsed.catalogNumbers)
      ? (parsed.catalogNumbers as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 4)
      : [];
    const suggestedRequery =
      typeof parsed.suggestedRequery === "string" && parsed.suggestedRequery.trim()
        ? parsed.suggestedRequery.trim()
        : translatedTerms.join(" ");

    let substitutes: object[] = [];
    if (suggestedRequery) {
      try {
        const subRows = await db
          .select()
          .from(inventoryTable)
          .where(
            sql`${inventoryFtsVector()} @@ websearch_to_tsquery('english', ${suggestedRequery})`,
          )
          .orderBy(
            sql`ts_rank_cd(${inventoryFtsVector()}, websearch_to_tsquery('english', ${suggestedRequery})) DESC`,
          )
          .limit(3);

        substitutes = subRows.map((item, i) => ({
          item,
          confidence: Math.max(0.55, 0.75 - i * 0.08),
          matchReason: "AI suggested substitute",
          seriesLabel: null,
          variants: [],
        }));
      } catch (subErr) {
        logger.warn({ err: subErr }, "translate-query: substitute inventory search failed");
      }
    }

    return void res.json({
      translatedTerms,
      interpretation,
      appliedTranslation,
      partName,
      partSpecs,
      catalogNumbers,
      suggestedRequery,
      substitutes,
    });
  } catch (err) {
    if (isPoeAuthError(err)) {
      logger.error({ err }, "AI auth error in POST /ai/translate-query");
      return void res.status(401).json({ error: poeErrorMessage(err) });
    }
    if (err instanceof OpenAI.RateLimitError) {
      logger.error({ err }, "AI rate-limit error in POST /ai/translate-query");
      return void res.status(429).json({ error: poeErrorMessage(err) });
    }
    if (isPoeTransientError(err)) {
      logger.error({ err }, "AI transient error in POST /ai/translate-query");
      return void res.status(503).json({ error: poeErrorMessage(err) });
    }
    const aiMsg = poeErrorMessage(err);
    if (aiMsg) {
      logger.error({ err }, "AI API error in POST /ai/translate-query");
      return void res.status(502).json({ error: aiMsg });
    }
    logger.error({ err }, "Unexpected error in POST /ai/translate-query");
    res.status(500).json({ error: "Query translation failed" });
  }
});

// POST /ai/reference — deprecated alias, forwards to /reference/ask behavior
// Kept for backwards compat; primary route is /reference/ask
router.post("/reference", async (req, res) => {
  res.status(308).json({ message: "Use /api/reference/ask instead" });
});

export default router;
