import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { quickLookupCacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const GENERIC_ERROR_MESSAGE =
  "Sorry, the reference assistant ran into a problem. Please try again.";

/** Collect the full streamed OpenAI response and return the text. */
async function collectStreamedAnswer(question: string): Promise<string> {
  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_completion_tokens: 512,
    stream: true,
    messages: [
      {
        role: "system",
        content:
          "You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.",
      },
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

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 512,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.",
        },
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
