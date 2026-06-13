import { Router, type Request, type Response, type NextFunction } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { isPoeAuthError, poeErrorMessage } from "@workspace/integrations-poe-server";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { quickLookupCacheTable, inventoryTable, referenceLogTable, aiRequestLogTable } from "@workspace/db";
import { desc, eq, lt, or, ilike, sql } from "drizzle-orm";
import { verifyAdminToken } from "./admin";
import {
  normalizeQuestion,
  hashQuestion,
  getCachedAnswer,
  setCachedAnswer,
} from "../lib/answerCache";

const router = Router();

const adminPassword = process.env.ADMIN_PASSWORD ?? "";

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Admin authentication required" });
    return;
  }
  next();
}

const GENERIC_ERROR_MESSAGE =
  "Sorry, the reference assistant ran into a problem. Please try again.";

const BASE_SYSTEM_PROMPT =
  "You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.";

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

/** Collect the full streamed OpenAI response and return the text + matched count. */
async function collectStreamedAnswer(question: string): Promise<{ answer: string; matchedItemCount: number }> {
  const { context: inventoryContext, count: matchedItemCount } = await buildInventoryContext(question);
  const systemContent = BASE_SYSTEM_PROMPT + inventoryContext;

  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_completion_tokens: 512,
    stream: true,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: question },
    ],
  });

  let fullText = "";
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) fullText += content;
  }
  return { answer: fullText, matchedItemCount };
}

// POST /reference/ask — SSE streaming or JSON reference Q&A
router.post("/ask", async (req, res) => {
  try {
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return void res.status(400).json({ error: "question is required" });
    }

    const normalized = normalizeQuestion(question);
    const questionHash = hashQuestion(normalized);

    const wantsJson =
      req.query["stream"] === "false" ||
      (req.headers["accept"] ?? "").includes("application/json");

    if (wantsJson) {
      const cached = await getCachedAnswer(questionHash);
      if (cached !== null) {
        logger.debug({ questionHash }, "reference.ask cache hit (json)");
        writeAiRequestLog("reference");
        return void res.json({ answer: cached });
      }

      const { answer, matchedItemCount } = await collectStreamedAnswer(question.trim());
      writeReferenceLog(question.trim(), answer, matchedItemCount);
      setCachedAnswer(questionHash, normalized, answer).catch(() => {});
      writeAiRequestLog("reference");
      return void res.json({ answer });
    }

    // SSE path: check cache first, stream from OpenAI on miss and cache after.
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

    const { context: inventoryContext, count: matchedItemCount } = await buildInventoryContext(question.trim());
    const systemContent = BASE_SYSTEM_PROMPT + inventoryContext;

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 512,
      stream: true,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: question },
      ],
    });

    let fullAnswer = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullAnswer += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

    writeReferenceLog(question.trim(), fullAnswer, matchedItemCount);
    writeAiRequestLog("reference");
    if (fullAnswer) {
      setCachedAnswer(questionHash, normalized, fullAnswer).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "reference.ask failed");
    const poeMsg = poeErrorMessage(err);
    if (poeMsg !== null) {
      const status = isPoeAuthError(err) ? 401 : 502;
      if (res.headersSent) {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ error: poeMsg })}\n\n`);
        } catch {
          // Connection may already be torn down.
        }
        res.end();
      } else {
        res.status(status).json({ error: poeMsg });
      }
      return;
    }
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
router.post("/quick-lookups/:label", async (req, res) => {
  try {
    const { label } = req.params;
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return void res.status(400).json({ error: "question is required" });
    }

    const { answer } = await collectStreamedAnswer(question.trim());

    // Upsert into DB cache
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
    const poeMsg = poeErrorMessage(err);
    if (poeMsg !== null) {
      res.status(isPoeAuthError(err) ? 401 : 502).json({ error: poeMsg });
      return;
    }
    res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
  }
});

export default router;
