import { getAuth } from "@clerk/express";
import { AiIdentifyBodySchema, AiPartCardBodySchema,AiTranslateQueryBodySchema } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { aiRequestLogTable, inventoryFtsVector, inventoryTable, partCardCacheTable } from "@workspace/db";
import { isPoeAuthError, isPoeTransientError, poeErrorMessage } from "@workspace/integrations-poe-server";
import { lt, sql } from "drizzle-orm";
import { Router } from "express";
import OpenAI from "openai";

import { getAiClient, getEnrichModel, getOpenAIFallbackClient, getOpenAIModelForFeature } from "../lib/aiProvider";
import { getLogger } from "../lib/logger";
import { PoeBotChainExhaustedError,tryPoeBotChain } from "../lib/poeBot";
import { MAX_IMAGE_BYTES_CLAUDE_SONNET } from "../lib/poeModelLimits";
import { identifyLimiter, partCardLimiter,translateLimiter } from "../lib/rateLimiter";
import { buildImageContent, checkImagePayloadSize, checkPerImageSize, extractJsonFromText, isProviderPayloadTooLargeError,normalizeAnalysis } from "../utils/aiHelpers";

/** Returns the rate-limit key for a request: Clerk userId if available, else IP. */
function rateLimitKey(req: Parameters<typeof getAuth>[0]): string {
  return getAuth(req)?.userId ?? String(req.ip ?? "unknown");
}

const router = Router();

// POST /ai/identify
router.post("/identify", async (req, res) => {
  const reqLogger = getLogger(res);
  try {
    const rateCheck = await identifyLimiter.check(rateLimitKey(req), res.locals.requestId as string | undefined);
    if (!rateCheck.allowed) {
      res.set("Retry-After", String(Math.ceil(rateCheck.retryAfterMs / 1000)));
      return void res.status(429).json({ error: "Too many identify requests. Please slow down." });
    }

    const identifyBody = AiIdentifyBodySchema.safeParse(req.body);
    if (!identifyBody.success) {
      const issue = identifyBody.error.issues[0];
      // A missing `images` field yields Zod's generic "Required" message; map it
      // to the same actionable text as the empty-array (min(1)) case. Other
      // image errors (e.g. too_big for >10 images) keep their own message.
      const message =
        issue?.path[0] === "images" && issue.code === "invalid_type"
          ? "At least one image is required"
          : issue?.message ?? "Invalid request body";
      return void res.status(400).json({ error: message });
    }

    const {
      images = [],
      keywords = "",
      vendor = "",
      color = "",
      size = "",
      material = "",
      textNumbers = "",
    } = identifyBody.data;

    if (!images.length) {
      return void res.status(400).json({ error: "At least one image is required" });
    }

    // Read the fallback header early so it's available for per-model size checks.
    const useOpenAiFallback = req.headers["x-use-openai-fallback"] === "true";

    const payloadCheck = checkImagePayloadSize(images);
    if (!payloadCheck.ok) {
      return void res.status(413).json({ error: payloadCheck.message });
    }

    // Per-image check for Claude Sonnet: Anthropic enforces a 10 MB per-image
    // limit that is tighter than the 20 MB aggregate cap above.  An image
    // between 10–20 MB would pass the aggregate check but be silently rejected
    // by Anthropic.  Apply this check for the Poe path (Claude is the primary
    // model).  The OpenAI fallback uses gpt-4o (20 MB per image), already
    // covered by the aggregate check above.
    if (!useOpenAiFallback) {
      const perImageCheck = checkPerImageSize(images, MAX_IMAGE_BYTES_CLAUDE_SONNET);
      if (!perImageCheck.ok) {
        return void res.status(413).json({ error: perImageCheck.message });
      }
    }

    const contextParts: Array<string> = [];
    if (keywords) contextParts.push(`Keywords: ${keywords}`);
    if (vendor) contextParts.push(`Manufacturer/Vendor: ${vendor}`);
    if (color) contextParts.push(`Color: ${color}`);
    if (size) contextParts.push(`Size: ${size}`);
    if (material) contextParts.push(`Material: ${material}`);
    if (textNumbers) contextParts.push(`Text/Numbers visible: ${textNumbers}`);
    const contextStr = contextParts.join("\n");

    const imageContent = buildImageContent(images);

    const identifyMessages = [
      {
        role: "system" as const,
        content:
          "You are an expert electrical supply warehouse specialist. Analyze the provided image(s) and identify the electrical part. Return ONLY valid JSON with these fields: partNumbers (string[]), searchTerms (string[]), synonyms (string[]), relatedTerms (string[]), manufacturerVerified (boolean), detectedVendor (string|null), summary (string). partNumbers must contain ONLY the exact catalog/part numbers you can read directly from the image or label (e.g. [\"CHB5\", \"QO115\"]); leave it empty if no part number is clearly visible. searchTerms should include all descriptive terms, part numbers, manufacturer codes, and alternative names.",
      },
      {
        role: "user" as const,
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
    ];

    const response = useOpenAiFallback
      ? await getOpenAIFallbackClient().chat.completions.create({
          model: getOpenAIModelForFeature("identify"),
          max_completion_tokens: 1024,
          messages: identifyMessages,
        })
      : await tryPoeBotChain("identify", (client, model) =>
          client.chat.completions.create({
            model,
            max_completion_tokens: 1024,
            messages: identifyMessages,
          }),
        );

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
        reqLogger.warn({ err }, "ai_request_log insert failed");
      }
    });
  } catch (err) {
    if (err instanceof PoeBotChainExhaustedError) {
      reqLogger.warn("Poe chain exhausted in POST /ai/identify");
      return void res.status(503).json({ status: "poe_chain_exhausted" });
    }
    if (isPoeAuthError(err)) {
      reqLogger.error({ err }, "AI auth error in POST /ai/identify");
      return void res.status(401).json({ error: poeErrorMessage(err) });
    }
    if (err instanceof OpenAI.RateLimitError) {
      reqLogger.error({ err }, "AI rate-limit/quota error in POST /ai/identify");
      return void res.status(429).json({ error: poeErrorMessage(err) });
    }
    if (isProviderPayloadTooLargeError(err)) {
      reqLogger.warn({ err }, "Provider payload-too-large error in POST /ai/identify");
      return void res.status(413).json({
        error: "Image payload too large — the AI provider rejected the request. Please use smaller or fewer images.",
      });
    }
    if (isPoeTransientError(err)) {
      reqLogger.error({ err }, "AI transient error in POST /ai/identify");
      return void res.status(503).json({ error: poeErrorMessage(err) });
    }
    const aiMsg = poeErrorMessage(err);
    if (aiMsg) {
      reqLogger.error({ err }, "AI API error in POST /ai/identify");
      return void res.status(502).json({ error: aiMsg });
    }
    reqLogger.error({ err }, "Unexpected error in POST /ai/identify");
    res.status(500).json({ error: "AI identification failed" });
  }
});

// POST /ai/translate-query
// Translates a plain-language parts query into catalog vocabulary.
// When zeroResults=true, also identifies the part and finds substitute inventory matches.
router.post("/translate-query", async (req, res) => {
  const reqLogger = getLogger(res);
  try {
    const rateCheck = await translateLimiter.check(rateLimitKey(req), res.locals.requestId as string | undefined);
    if (!rateCheck.allowed) {
      res.set("Retry-After", String(Math.ceil(rateCheck.retryAfterMs / 1000)));
      return void res.status(429).json({ error: "Too many translate-query requests. Please slow down." });
    }

    const translateBody = AiTranslateQueryBodySchema.safeParse(req.body);
    if (!translateBody.success) {
      return void res.status(400).json({ error: translateBody.error.issues[0]?.message ?? "Invalid request body" });
    }

    const { query = "", zeroResults = false } = translateBody.data;

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

    const response = await getAiClient().chat.completions.create({
      model: getEnrichModel(),
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userContent },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "{}";
    const parsed = extractJsonFromText(text) ?? {};

    const translatedTerms = Array.isArray(parsed.translatedTerms)
      ? (parsed.translatedTerms as Array<unknown>).filter((t): t is string => typeof t === "string").slice(0, 8)
      : [];
    const interpretation = typeof parsed.interpretation === "string" ? parsed.interpretation : "";
    const appliedTranslation =
      typeof parsed.appliedTranslation === "boolean" ? parsed.appliedTranslation : translatedTerms.length > 0;

    if (!zeroResults) {
      return void res.json({ translatedTerms, interpretation, appliedTranslation });
    }

    const partName = typeof parsed.partName === "string" ? parsed.partName : "";
    const partSpecs = Array.isArray(parsed.partSpecs)
      ? (parsed.partSpecs as Array<unknown>).filter((s): s is string => typeof s === "string").slice(0, 6)
      : [];
    const catalogNumbers = Array.isArray(parsed.catalogNumbers)
      ? (parsed.catalogNumbers as Array<unknown>).filter((s): s is string => typeof s === "string").slice(0, 4)
      : [];
    const suggestedRequery =
      typeof parsed.suggestedRequery === "string" && parsed.suggestedRequery.trim()
        ? parsed.suggestedRequery.trim()
        : translatedTerms.join(" ");

    let substitutes: Array<object> = [];
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
        reqLogger.warn({ err: subErr }, "translate-query: substitute inventory search failed");
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
      reqLogger.error({ err }, "AI auth error in POST /ai/translate-query");
      return void res.status(401).json({ error: poeErrorMessage(err) });
    }
    if (err instanceof OpenAI.RateLimitError) {
      reqLogger.error({ err }, "AI rate-limit error in POST /ai/translate-query");
      return void res.status(429).json({ error: poeErrorMessage(err) });
    }
    if (isPoeTransientError(err)) {
      reqLogger.error({ err }, "AI transient error in POST /ai/translate-query");
      return void res.status(503).json({ error: poeErrorMessage(err) });
    }
    const aiMsg = poeErrorMessage(err);
    if (aiMsg) {
      reqLogger.error({ err }, "AI API error in POST /ai/translate-query");
      return void res.status(502).json({ error: aiMsg });
    }
    reqLogger.error({ err }, "Unexpected error in POST /ai/translate-query");
    res.status(500).json({ error: "Query translation failed" });
  }
});

// L1 in-memory cache for part-card lookups keyed by "catalog|vendor"
const partCardCache = new Map<string, { data: object; cachedAt: number; dbCachedAt: string | null }>();
const PART_CARD_L1_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (in-process hot cache)
const PART_CARD_DB_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (DB persistent cache)

// POST /ai/part-card
// Returns web-sourced part info: display name, key specs, cross-refs, compatibility note.
// Results are cached: L1 in-memory (24h) → L2 database (30-day TTL) → AI call.
// Pass force: true to bypass all cache layers and re-fetch from AI.
router.post("/part-card", async (req, res) => {
  const reqLogger = getLogger(res);
  try {
    const rateCheck = await partCardLimiter.check(rateLimitKey(req), res.locals.requestId as string | undefined);
    if (!rateCheck.allowed) {
      res.set("Retry-After", String(Math.ceil(rateCheck.retryAfterMs / 1000)));
      return void res.status(429).json({ error: "Too many part-card requests. Please slow down." });
    }

    const partCardBody = AiPartCardBodySchema.safeParse(req.body);
    if (!partCardBody.success) {
      return void res.status(400).json({ error: partCardBody.error.issues[0]?.message ?? "Invalid request body" });
    }

    const {
      catalog = "",
      vendor = "",
      description = "",
      force = false,
    } = partCardBody.data;

    if (!catalog.trim()) {
      return void res.status(400).json({ error: "catalog is required" });
    }

    const cacheKey = `${catalog.trim().toLowerCase()}|${vendor.trim().toLowerCase()}`;

    if (!force) {
      // L1: serve from in-memory cache if fresh
      const cached = partCardCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < PART_CARD_L1_TTL_MS) {
        return void res.json({ ...cached.data, cachedAt: cached.dbCachedAt });
      }

      // L2: check the database for a row younger than 30 days
      const thirtyDaysAgo = new Date(Date.now() - PART_CARD_DB_TTL_MS);
      try {
        const [dbRow] = await db
          .select()
          .from(partCardCacheTable)
          .where(
            sql`${partCardCacheTable.catalogKey} = ${cacheKey} AND ${partCardCacheTable.cachedAt} > ${thirtyDaysAgo}`,
          )
          .limit(1);

        if (dbRow) {
          const data = dbRow.data as object;
          const dbCachedAt = dbRow.cachedAt instanceof Date ? dbRow.cachedAt.toISOString() : String(dbRow.cachedAt);
          partCardCache.set(cacheKey, { data, cachedAt: Date.now(), dbCachedAt });
          return void res.json({ ...data, cachedAt: dbCachedAt });
        }
      } catch (dbErr) {
        reqLogger.warn({ err: dbErr }, "part-card: DB cache read failed, proceeding to AI");
      }
    } else {
      // Force refresh: evict L1 so stale data isn't served while the AI call is in flight
      partCardCache.delete(cacheKey);
    }

    const contextParts: Array<string> = [];
    if (vendor.trim()) contextParts.push(`Manufacturer/Vendor: ${vendor.trim()}`);
    if (description.trim()) contextParts.push(`Description: ${description.trim()}`);

    const systemContent = [
      "You are an expert electrical supply parts specialist with deep knowledge of industrial components.",
      "Given a part catalog number and optional context, return structured web-sourced information about the part.",
      "Return ONLY valid JSON with these fields:",
      "- displayName: string — the common product name (e.g. 'Square D 15A Single-Pole Circuit Breaker')",
      "- specs: Array<{label: string; value: string}> — key specs (voltage, amperage, NEMA rating, frame, poles, interrupting rating, trip type, UL listed, etc.). Include 3–8 specs.",
      "- crossRefs: string[] — up to 4 equivalent part numbers from other manufacturers (empty array if unknown)",
      "- compatibilityNote: string — brief note about compatible panels/systems (empty string if unknown)",
      "If you have no reliable information about this specific part, return: {displayName: \"\", specs: [], crossRefs: [], compatibilityNote: \"\"}",
    ].join("\n");

    const userContent = [
      `Part catalog number: ${catalog.trim()}`,
      ...contextParts,
      "Return JSON only.",
    ].join("\n");

    const response = await getAiClient().chat.completions.create({
      model: getEnrichModel(),
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userContent },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "{}";
    const parsed = extractJsonFromText(text) ?? {};

    const displayName = typeof parsed.displayName === "string" ? parsed.displayName : "";
    const specs = Array.isArray(parsed.specs)
      ? (parsed.specs as Array<unknown>).filter(
          (s): s is { label: string; value: string } =>
            typeof s === "object" && s !== null &&
            typeof (s as { label?: unknown }).label === "string" &&
            typeof (s as { value?: unknown }).value === "string",
        ).slice(0, 10)
      : [];
    const crossRefs = Array.isArray(parsed.crossRefs)
      ? (parsed.crossRefs as Array<unknown>).filter((s): s is string => typeof s === "string").slice(0, 6)
      : [];
    const compatibilityNote = typeof parsed.compatibilityNote === "string" ? parsed.compatibilityNote : "";

    const data = { displayName, specs, crossRefs, compatibilityNote };

    // Only cache if we got something useful
    if (displayName || specs.length > 0 || crossRefs.length > 0 || compatibilityNote) {
      // Populate L1 immediately
      partCardCache.set(cacheKey, { data, cachedAt: Date.now(), dbCachedAt: null });
      // Evict oldest entries until the cache is within the 500-entry limit
      if (partCardCache.size > 500) {
        const sorted = [...partCardCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
        for (const [key] of sorted) {
          partCardCache.delete(key);
          if (partCardCache.size <= 500) break;
        }
      }

      // Fire-and-forget: upsert into DB (non-blocking)
      setImmediate(async () => {
        try {
          await db
            .insert(partCardCacheTable)
            .values({ catalogKey: cacheKey, data, cachedAt: new Date() })
            .onConflictDoUpdate({
              target: partCardCacheTable.catalogKey,
              set: { data, cachedAt: new Date() },
            });
        } catch (dbErr) {
          reqLogger.warn({ err: dbErr }, "part-card: DB cache write failed");
        }
      });
    }

    return void res.json({ ...data, cachedAt: null });
  } catch (err) {
    if (isPoeAuthError(err)) {
      reqLogger.error({ err }, "AI auth error in POST /ai/part-card");
      return void res.status(401).json({ error: poeErrorMessage(err) });
    }
    if (err instanceof OpenAI.RateLimitError) {
      reqLogger.error({ err }, "AI rate-limit error in POST /ai/part-card");
      return void res.status(429).json({ error: poeErrorMessage(err) });
    }
    if (isPoeTransientError(err)) {
      reqLogger.error({ err }, "AI transient error in POST /ai/part-card");
      return void res.status(503).json({ error: poeErrorMessage(err) });
    }
    const aiMsg = poeErrorMessage(err);
    if (aiMsg) {
      reqLogger.error({ err }, "AI API error in POST /ai/part-card");
      return void res.status(502).json({ error: aiMsg });
    }
    reqLogger.error({ err }, "Unexpected error in POST /ai/part-card");
    res.status(500).json({ error: "Part card lookup failed" });
  }
});

// POST /ai/reference — removed; use /api/reference/ask
router.post("/reference", (_req, res) => {
  res.status(410).json({ error: "This endpoint has been removed. Use /api/reference/ask instead." });
});

export default router;
