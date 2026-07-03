import { Router } from "express";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { quickLookupCacheTable, inventoryTable, referenceLogTable, aiRequestLogTable } from "@workspace/db";
import { desc, eq, lt, or, ilike, sql } from "drizzle-orm";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";
import {
  normalizeQuestion,
  hashQuestion,
  getCachedAnswer,
  setCachedAnswer,
} from "../lib/answerCache";
import { callGemini, callGeminiWithHistory, WEB_REFERENCE_MODEL } from "../lib/webSearch";

const router = Router();

const GENERIC_ERROR_MESSAGE =
  "Sorry, the reference assistant ran into a problem. Please try again.";

/**
 * Concise description of the Parts ID app injected into the system prompt so
 * the AI can answer "how does this app work?" questions without a web search.
 */
const APP_KNOWLEDGE = `
## About the Parts ID App

Parts ID is a mobile warehouse app for managing and identifying electrical supply inventory.

**Key features:**
- **Search tab:** Full-text search across all inventory items (vendor, catalog number, description, AI keywords). Supports partial and keyword matching. Tapping a result shows full part details including expanded descriptions, dimensions, and barcode.
- **Photo ID tab:** Workers point the camera at a part and the AI identifies it by comparing the photo against inventory descriptions and visual cues. Returns the best matching part.
- **Barcode scan:** Scan a part's barcode to instantly look it up in inventory. Accessible from the Search tab and part detail screens.
- **CSV import (admin):** Admins upload a CSV file of inventory items (vendor, catalog, description columns required). The server parses, deduplicates, and stores them.
- **Admin upload / photo upload:** Admins can attach product images to inventory items directly from the app.
- **Offline cache:** Recently viewed parts and quick-lookup chip answers are cached locally so workers can browse without a network connection.
- **AI enrichment:** Admins can trigger bulk AI keyword generation for inventory items. The AI adds searchable keywords and an expanded description to every item, making search far more effective.
- **Reference modal (this assistant):** A floating button on the main screen opens this AI chat. Workers can ask any question — electrical codes, part terminology, how the app works, or general warehouse questions.
- **Settings:** Workers can set the server URL (API base), toggle dark mode, and view app version info.
- **Cycle counting:** Visual overlay on the map screen for counting parts in bin locations.
- **Warehouse map / floor plan:** Interactive floor plan showing bin locations, zone assignments, and aisle labels.
`;

const BASE_SYSTEM_PROMPT = `You are a concise warehouse parts and general reference assistant for warehouse workers using the Parts ID app. You help with:
- Electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology
- Any general question a warehouse worker might have
- Questions about how the Parts ID app works (features, how-tos, capabilities)

Always check the inventory context below first. If relevant inventory items are listed, reference them.
Use **bold** for key terms and - bullets for lists. Keep answers under 250 words. Be precise and practical.

When you use your web search capability to answer a question, prefix your final answer with "*(web)*" on its own line so the worker knows the answer came from a live web search.
${APP_KNOWLEDGE}`;

/**
 * Search the inventory for items relevant to the question.
 * Returns the formatted context string AND the matched row count.
 */
async function buildInventoryContext(question: string): Promise<{ context: string; count: number }> {
  try {
    const tokens = question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (tokens.length === 0) return { context: "", count: 0 };

    const conditions = tokens.flatMap((token) => [
      ilike(inventoryTable.description, `%${token}%`),
      ilike(sql`array_to_string(${inventoryTable.aiKeywords}, ' ')`, `%${token}%`),
    ]);

    const rows = await db
      .select({
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
      })
      .from(inventoryTable)
      .where(or(...conditions))
      .limit(15);

    if (rows.length === 0) return { context: "", count: 0 };

    const lines = rows.map(
      (r) =>
        `${r.vendor} | ${r.catalog} | ${r.description.slice(0, 80)}${r.description.length > 80 ? "…" : ""}`,
    );

    return {
      context: `\n\nRelevant items currently in this warehouse's inventory:\n${lines.join("\n")}`,
      count: rows.length,
    };
  } catch (err) {
    logger.warn({ err }, "inventory context lookup failed — skipping enrichment");
    return { context: "", count: 0 };
  }
}

/** Fire-and-forget: log an AI request and prune entries older than 90 days. */
function writeAiRequestLog(feature: "reference"): void {
  setImmediate(async () => {
    try {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await db.insert(aiRequestLogTable).values({ feature });
      await db.delete(aiRequestLogTable).where(lt(aiRequestLogTable.createdAt, ninetyDaysAgo));
    } catch (err) {
      logger.warn({ err }, "ai_request_log write failed");
    }
  });
}

/** Fire-and-forget: write a Q&A log row and prune entries older than 30 days. */
function writeReferenceLog(question: string, answer: string, matchedItemCount: number): void {
  setImmediate(async () => {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await db.insert(referenceLogTable).values({ question, answer, matchedItemCount });
      await db.delete(referenceLogTable).where(lt(referenceLogTable.createdAt, thirtyDaysAgo));
    } catch (err) {
      logger.warn({ err }, "reference log write failed");
    }
  });
}

/**
 * Call Gemini-2.5-Flash via Replit AI Integrations for a reference answer.
 * Returns the answer text and whether the answer appears to be web-sourced.
 */
async function callGeminiReference(
  systemContent: string,
  question: string,
): Promise<{ answer: string; usedWebSearch: boolean }> {
  const answer = await callGemini(systemContent, question);
  const usedWebSearch = answer.trimStart().startsWith("*(web)*");
  return { answer, usedWebSearch };
}

/**
 * Collect the full answer via Gemini-2.5-Flash (single-turn, cacheable).
 * Returns the text, matched inventory count, and whether web search was used.
 */
async function collectAnswer(
  question: string,
): Promise<{ answer: string; matchedItemCount: number; usedWebSearch: boolean }> {
  const { context: inventoryContext, count: matchedItemCount } = await buildInventoryContext(question);
  const systemContent = BASE_SYSTEM_PROMPT + inventoryContext;
  const { answer, usedWebSearch } = await callGeminiReference(systemContent, question);
  return { answer, matchedItemCount, usedWebSearch };
}

/**
 * Collect a multi-turn answer via Gemini-2.5-Flash (history-aware, not cached).
 * Returns the text, matched inventory count, and whether web search was used.
 */
async function collectAnswerWithHistory(
  question: string,
  history: { q: string; a: string }[],
): Promise<{ answer: string; matchedItemCount: number; usedWebSearch: boolean }> {
  const { context: inventoryContext, count: matchedItemCount } = await buildInventoryContext(question);
  const systemContent = BASE_SYSTEM_PROMPT + inventoryContext;
  const answer = await callGeminiWithHistory(systemContent, history, question);
  const usedWebSearch = answer.trimStart().startsWith("*(web)*");
  return { answer, matchedItemCount, usedWebSearch };
}

// POST /reference/ask — SSE streaming or JSON reference Q&A
router.post("/ask", async (req, res) => {
  try {
    const { question, history } = req.body as {
      question: string;
      history?: { q: string; a: string }[];
    };
    if (!question?.trim()) {
      return void res.status(400).json({ error: "question is required" });
    }

    const hasHistory = Array.isArray(history) && history.length > 0;
    const normalized = normalizeQuestion(question);
    const questionHash = hashQuestion(normalized);

    const wantsJson =
      req.query["stream"] === "false" ||
      (req.headers["accept"] ?? "").includes("application/json");

    if (wantsJson) {
      if (!hasHistory) {
        const cached = await getCachedAnswer(questionHash);
        if (cached !== null) {
          logger.debug({ questionHash }, "reference.ask cache hit (json)");
          writeAiRequestLog("reference");
          return void res.json({ answer: cached });
        }
      }

      const { answer, matchedItemCount, usedWebSearch } = hasHistory
        ? await collectAnswerWithHistory(question.trim(), history!)
        : await collectAnswer(question.trim());
      writeReferenceLog(question.trim(), answer, matchedItemCount);
      if (!hasHistory) {
        setCachedAnswer(questionHash, normalized, answer, usedWebSearch).catch((err) => logger.warn({ err }, "cache write failed"));
      }
      writeAiRequestLog("reference");
      return void res.json({ answer });
    }

    // SSE path: check cache first, then call Gemini-2.5-Flash on miss.
    const cached = await getCachedAnswer(questionHash);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (cached !== null) {
      logger.debug({ questionHash }, "reference.ask cache hit (sse)");
      writeAiRequestLog("reference");
      res.write(`data: ${JSON.stringify({ content: cached })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }

    // Gemini-2.5-Flash call (non-streaming internally; pseudo-stream to client).
    const { answer: fullAnswer, matchedItemCount, usedWebSearch } = await collectAnswer(question.trim());

    // Emit the answer word-by-word for a live-typing effect.
    const words = fullAnswer.split(" ");
    for (let i = 0; i < words.length; i++) {
      const chunk = (i === 0 ? "" : " ") + words[i];
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

    writeReferenceLog(question.trim(), fullAnswer, matchedItemCount);
    writeAiRequestLog("reference");
    if (fullAnswer) {
      setCachedAnswer(questionHash, normalized, fullAnswer, usedWebSearch).catch((err) => logger.warn({ err }, "cache write failed"));
    }
  } catch (err) {
    logger.error({ err }, "reference.ask failed");
    if (res.headersSent) {
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: GENERIC_ERROR_MESSAGE })}\n\n`,
        );
      } catch {
        // Connection may already be torn down.
      }
      res.end();
    } else {
      res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
    }
  }
});

// GET /reference/ask-log — admin-only list of recent Q&A log rows
router.get("/ask-log", requireAdminAuth, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(referenceLogTable)
      .orderBy(desc(referenceLogTable.createdAt))
      .limit(100);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, "reference.ask-log list failed");
    res.status(500).json({ error: "Failed to load AI log" });
  }
});

// GET /reference/quick-lookups — return all cached rows (includes updatedAt for client-side TTL)
router.get("/quick-lookups", async (_req, res) => {
  try {
    const rows = await db
      .select({
        label: quickLookupCacheTable.label,
        answer: quickLookupCacheTable.answer,
        updatedAt: quickLookupCacheTable.updatedAt,
      })
      .from(quickLookupCacheTable);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, "reference.quick-lookups list failed");
    res.status(500).json({ error: "Failed to load quick lookups" });
  }
});

// GET /reference/quick-lookups/:label — single row or 404
router.get("/quick-lookups/:label", async (req, res) => {
  try {
    const { label } = req.params;
    const rows = await db
      .select({ answer: quickLookupCacheTable.answer })
      .from(quickLookupCacheTable)
      .where(eq(quickLookupCacheTable.label, label))
      .limit(1);

    if (rows.length === 0) {
      return void res.status(404).json({ error: "Not found" });
    }
    res.json({ answer: rows[0]!.answer });
  } catch (err) {
    logger.error({ err }, "reference.quick-lookups get failed");
    res.status(500).json({ error: "Failed to load quick lookup" });
  }
});

// POST /reference/quick-lookups/:label — AI fallback + DB write-back
// Called internally by the mobile client when cache misses at all layers.
router.post("/quick-lookups/:label", requireAdminAuth, async (req, res) => {
  try {
    const label = req.params["label"] as string;
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return void res.status(400).json({ error: "question is required" });
    }

    const { answer } = await collectAnswer(question.trim());

    await db
      .insert(quickLookupCacheTable)
      .values({ label, answer, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: quickLookupCacheTable.label,
        set: { answer, updatedAt: new Date() },
      });

    res.json({ answer });
  } catch (err) {
    logger.error({ err }, "reference.quick-lookups post failed");
    res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
  }
});

export default router;
