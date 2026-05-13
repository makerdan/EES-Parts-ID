import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const router = Router();

const GENERIC_ERROR_MESSAGE =
  "Sorry, the reference assistant ran into a problem. Please try again.";

// POST /reference/ask — SSE streaming reference Q&A
router.post("/ask", async (req, res) => {
  try {
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return void res.status(400).json({ error: "question is required" });
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

    // Switch to SSE only once we know the upstream call succeeded — that way
    // failures from openai.create still produce a normal JSON HTTP error.
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
      // Stream already started — emit a terminal SSE error frame so the
      // client can distinguish a clean end from a mid-stream failure.
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: GENERIC_ERROR_MESSAGE })}\n\n`,
        );
      } catch {
        // Connection may already be torn down; nothing more we can do.
      }
      res.end();
    } else {
      // No bytes written yet — return a normal HTTP error response.
      res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
    }
  }
});

export default router;
