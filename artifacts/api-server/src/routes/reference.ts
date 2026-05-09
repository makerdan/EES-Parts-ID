/**
 * Reference data endpoints consumed by the mobile Reference modal — a
 * thin alias layer over /dictionaries kept separate so the mobile UI's
 * URL contract can evolve without churn in the dictionaries router.
 */
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { openai } from '@workspace/integrations-openai-ai-server';
import { db, quickLookupCache } from '@workspace/db';

const router = Router();

const REFERENCE_SYSTEM_PROMPT =
  'You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.';

// POST /reference/ask — reference Q&A
// Defaults to SSE streaming. Pass `?stream=false` or `Accept: application/json`
// to receive a single JSON response `{ answer: string }` instead (required for
// React Native iOS, which does not expose ReadableStream on fetch responses).
router.post('/ask', async (req, res) => {
  try {
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return void res.status(400).json({ error: 'question is required' });
    }

    const wantsJson =
      req.query.stream === 'false' || (req.headers.accept ?? '').includes('application/json');

    const messages = [
      { role: 'system' as const, content: REFERENCE_SYSTEM_PROMPT },
      { role: 'user' as const, content: question },
    ];

    if (wantsJson) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_completion_tokens: 512,
        stream: false,
        messages,
      });
      const answer = completion.choices[0]?.message?.content ?? '';
      return void res.json({ answer });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_completion_tokens: 512,
      stream: true,
      messages,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error(err);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// GET /reference/quick-lookups — returns all cached quick lookup answers
router.get('/quick-lookups', async (_req, res) => {
  try {
    const rows = await db
      .select({
        label: quickLookupCache.label,
        answer: quickLookupCache.answer,
      })
      .from(quickLookupCache);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load quick lookup cache' });
  }
});

// GET /reference/quick-lookups/:label — returns a single cached quick lookup answer by label
router.get('/quick-lookups/:label', async (req, res) => {
  try {
    const { label } = req.params;
    const [row] = await db
      .select({ answer: quickLookupCache.answer })
      .from(quickLookupCache)
      .where(eq(quickLookupCache.label, label))
      .limit(1);
    if (!row) {
      return void res.status(404).json({ error: 'Not cached' });
    }
    res.json({ answer: row.answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load quick lookup' });
  }
});

export default router;
