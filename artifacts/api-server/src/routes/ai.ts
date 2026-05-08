/**
 * AI routes:
 *   POST /ai/identify   — vision call (gpt-4o) that turns a photo into
 *                          ranked candidate parts. Returns a structured
 *                          JSON contract with match_type routing and telemetry.
 *   GET  /ai/reference  — SSE stream powering the Reference modal chat.
 *
 * Calls go through the Replit AI Integrations proxy so we don't need
 * raw OpenAI keys in the environment.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { openai } from '@workspace/integrations-openai-ai-server';
import { buildImageContent } from '../utils/aiHelpers';
import { handleVisionResponse, VisionParseError } from '../photo/handleVisionResponse';
import { db } from '@workspace/db';
import { inventoryTable, photoIdEventTable } from '@workspace/db';
import { eq, ilike, and } from 'drizzle-orm';

const router = Router();

// ── Vision prompt ─────────────────────────────────────────────────────────────
// Must be kept in sync with VisionContractSchema in handleVisionResponse.ts.
// The schema contract:
//   catalog_guess      — most likely manufacturer catalog/part number (string|null)
//   vendor_guess       — manufacturer / vendor name (string|null)
//   type_guess         — part category e.g. "circuit breaker", "conduit fitting" (string|null)
//   attributes         — typed electrical specs; all sub-fields nullable
//     amperage         — numeric amperage rating (number|null)
//     poles            — pole count (number|null)
//     voltage          — numeric voltage rating (number|null)
//     trade_size_in    — conduit/cable trade size in inches (number|null)
//     color            — body color (string|null)
//   descriptive_tokens — free-text search terms describing the part (string[])
//   confidence         — 0.0–1.0 overall identification confidence (number|null)
//   notes              — any caveats or ambiguities observed (string|null)
const VISION_SYSTEM_PROMPT = `You are an expert electrical supply warehouse specialist. \
Analyze the provided image(s) of an electrical part and return ONLY valid JSON matching \
this exact schema — no markdown, no explanation, no code fences:

{
  "catalog_guess": "<manufacturer catalog/part number visible or strongly implied, or null>",
  "vendor_guess": "<manufacturer/brand name, or null>",
  "type_guess": "<part category e.g. circuit breaker, GFCI outlet, EMT fitting, or null>",
  "attributes": {
    "amperage": <numeric amperage rating or null>,
    "poles": <number of poles or null>,
    "voltage": <numeric voltage rating or null>,
    "trade_size_in": <conduit/cable trade size in inches as decimal or null>,
    "color": "<body color or null>"
  },
  "descriptive_tokens": ["<search term>", ...],
  "confidence": <0.0 to 1.0 confidence in identification, or null>,
  "notes": "<any caveats, ambiguities, or why fields are null, or null>"
}

Rules:
- Return ONLY valid JSON. No markdown. No code fences.
- If a field cannot be determined from the image, use null.
- Do not guess catalog numbers unless you can see them or are highly confident.
- descriptive_tokens should contain 3–10 useful search keywords describing the part.`;

// ── POST /ai/identify ─────────────────────────────────────────────────────────
router.post('/identify', async (req, res) => {
  const startTime = Date.now();
  try {
    const {
      images = [],
      keywords = '',
      vendor = '',
      color = '',
      size = '',
      material = '',
      textNumbers = '',
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
      return void res.status(400).json({ error: 'At least one image is required' });
    }

    // Build a short SHA-256 fingerprint of the first image for telemetry dedup.
    const imageHash = crypto.createHash('sha256').update(images[0]!).digest('hex').slice(0, 16);

    // Append any user-provided context to the user turn.
    const contextParts: string[] = [];
    if (keywords) contextParts.push(`Keywords: ${keywords}`);
    if (vendor) contextParts.push(`Manufacturer/Vendor: ${vendor}`);
    if (color) contextParts.push(`Color: ${color}`);
    if (size) contextParts.push(`Size: ${size}`);
    if (material) contextParts.push(`Material: ${material}`);
    if (textNumbers) contextParts.push(`Text/Numbers visible: ${textNumbers}`);
    const contextStr = contextParts.join('\n');

    const imageContent = buildImageContent(images);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_completion_tokens: 512,
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text' as const,
              text: contextStr
                ? `Identify this electrical part. Additional context:\n${contextStr}`
                : 'Identify this electrical part.',
            },
          ],
        },
      ],
    });

    const rawText = response.choices[0]?.message?.content ?? '';

    // ── Parse & validate the Vision response ────────────────────────────────
    let vision;
    let parseOk = false;
    try {
      vision = handleVisionResponse(rawText);
      parseOk = true;
    } catch (parseErr) {
      // Log parse failure and return a graceful degradation response.
      if (parseErr instanceof VisionParseError) {
        console.error('[ai/identify] Vision parse failed:', parseErr.cause);
      } else {
        console.error('[ai/identify] Unexpected parse error:', parseErr);
      }

      // Non-blocking telemetry for parse failures.
      void db
        .insert(photoIdEventTable)
        .values({
          imageHash,
          visionRaw: { raw: rawText } as Record<string, unknown>,
          parseOk: false,
          latencyMs: Date.now() - startTime,
        })
        .catch((e) => console.error('[ai/identify] telemetry insert failed:', e));

      return void res.status(422).json({
        error:
          'Could not identify part from image — the AI response was not in the expected format. Please try again with a clearer photo.',
      });
    }

    // ── Three-path routing ───────────────────────────────────────────────────
    type MatchType = 'catalog_exact' | 'attribute_match' | 'descriptive';
    let matchType: MatchType = 'descriptive';
    let topResults: (typeof inventoryTable.$inferSelect)[] = [];

    // Path 1 — exact catalog lookup
    if (vision.catalog_guess) {
      const exactRows = await db
        .select()
        .from(inventoryTable)
        .where(ilike(inventoryTable.catalog, vision.catalog_guess))
        .limit(1);

      if (exactRows.length > 0) {
        matchType = 'catalog_exact';
        topResults = exactRows;
      }
    }

    // Path 2 — attribute match (vendor + amperage + poles required)
    if (matchType === 'descriptive') {
      const a = vision.attributes;
      const vendorGuess = vision.vendor_guess;
      if (vendorGuess && a?.amperage != null && a?.poles != null) {
        const conditions = [
          ilike(inventoryTable.vendor, `%${vendorGuess}%`),
          eq(inventoryTable.amperage, a.amperage),
          eq(inventoryTable.poleCount, a.poles),
        ];
        if (a.voltage != null) {
          conditions.push(eq(inventoryTable.voltage, a.voltage));
        }

        const attrRows = await db
          .select()
          .from(inventoryTable)
          .where(and(...conditions))
          .limit(5);

        if (attrRows.length > 0) {
          matchType = 'attribute_match';
          topResults = attrRows;
        }
      }
    }

    // Path 3 — descriptive fallback (client runs the full search)
    // topResults stays empty; the client uses searchTerms to drive its own query.

    const topResultId = topResults[0]?.id ?? null;
    const latencyMs = Date.now() - startTime;

    // ── Non-blocking telemetry ───────────────────────────────────────────────
    let photoEventId: number | null = null;
    try {
      const [row] = await db
        .insert(photoIdEventTable)
        .values({
          imageHash,
          visionRaw: vision as unknown as Record<string, unknown>,
          parseOk,
          catalogGuess: vision.catalog_guess,
          vendorGuess: vision.vendor_guess,
          matchType,
          topResultId,
          latencyMs,
        })
        .returning({ id: photoIdEventTable.id });
      photoEventId = row?.id ?? null;
    } catch (e) {
      console.error('[ai/identify] telemetry insert failed:', e);
    }

    // ── Build response ───────────────────────────────────────────────────────
    // Backward-compatible: always return searchTerms + synonyms so the client
    // can fall through to a keyword search when topResults is empty.
    const searchTerms = vision.descriptive_tokens;
    const detectedVendor = vision.vendor_guess;
    const summary =
      [
        vision.type_guess,
        vision.catalog_guess ? `Catalog: ${vision.catalog_guess}` : null,
        vision.confidence != null ? `Confidence: ${Math.round(vision.confidence * 100)}%` : null,
        vision.notes,
      ]
        .filter(Boolean)
        .join(' · ') || 'Part identified';

    res.json({
      searchTerms,
      synonyms: [] as string[],
      relatedTerms: [] as string[],
      manufacturerVerified: vision.vendor_guess != null,
      detectedVendor,
      summary,
      results: topResults,
      match_type: matchType,
      _telemetry: { photoEventId },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI identification failed' });
  }
});

// POST /ai/reference — deprecated alias, forwards to /reference/ask behavior
// Kept for backwards compat; primary route is /reference/ask
router.post('/reference', async (_req, res) => {
  res.status(308).json({ message: 'Use /api/reference/ask instead' });
});

export default router;
