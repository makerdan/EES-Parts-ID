import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { quickLookupCacheTable, inventoryTable } from "@workspace/db";
import { eq, or, ilike, sql } from "drizzle-orm";

const router = Router();

const GENERIC_ERROR_MESSAGE =
  "Sorry, the reference assistant ran into a problem. Please try again.";

const BASE_SYSTEM_PROMPT =
  "You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.";

/**
 * Search the inventory for items relevant to the question.
 * Splits the question into tokens and matches against description and aiKeywords.
 * Returns a formatted string section to inject into the system prompt, or an
 * empty string when nothing matches.
 */
async function buildInventoryContext(question: string): Promise<string> {
  try {
    const tokens = question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (tokens.length === 0) return "";

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

    if (rows.length === 0) return "";

    const lines = rows.map(
      (r) =>
        `${r.vendor} | ${r.catalog} | ${r.description.slice(0, 80)}${r.description.length > 80 ? "…" : ""}`,
    );

    return `\n\nRelevant items currently in this warehouse's inventory:\n${lines.join("\n")}`;
  } catch (err) {
    logger.warn({ err }, "inventory context lookup failed — skipping enrichment");
    return "";
  }
}

/** Collect the full streamed OpenAI response and return the text. */
async function collectStreamedAnswer(question: string): Promise<string> {
  const inventoryContext = await buildInventoryContext(question);
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
  return fullText;
}

// POST /reference/ask — SSE streaming or JSON reference Q&A
router.post("/ask", async (req, res) => {
  try {
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return void res.status(400).json({ error: "question is required" });
    }

    const wantsJson =
      req.query["stream"] === "false" ||
      (req.headers["accept"] ?? "").includes("application/json");

    if (wantsJson) {
      const answer = await collectStreamedAnswer(question.trim());
      return void res.json({ answer });
    }

    const inventoryContext = await buildInventoryContext(question.trim());
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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
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

    const answer = await collectStreamedAnswer(question.trim());

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
    res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
  }
});

export default router;
