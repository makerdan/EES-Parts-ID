/**
 * Reference data endpoints consumed by the mobile Reference modal — a
 * thin alias layer over /dictionaries kept separate so the mobile UI's
 * URL contract can evolve without churn in the dictionaries router.
 */
import { Router } from 'express';
import { openai } from '@workspace/integrations-openai-ai-server';
import { db, quickLookupCache } from '@workspace/db';

const router = Router();

// POST /reference/ask — SSE streaming reference Q&A
router.post('/ask', async (req, res) => {
  try {
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return void res.status(400).json({ error: 'question is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_completion_tokens: 512,
      stream: true,
      messages: [
        {
          role: 'system',
          content:
            'You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.',
        },
        { role: 'user', content: question },
      ],
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
    res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    res.end();
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

export default router;
