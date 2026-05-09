/**
 * Seeder for the `quick_lookup_cache` table.
 *
 * Iterates the 12 canonical Quick Lookup chip definitions, checks whether
 * each row is missing or older than 30 days, and calls the AI for any that
 * need refreshing. The full streamed response is collected before writing so
 * partial text never lands in the database.
 *
 * Called non-blocking from the server startup path — errors are logged but
 * never propagate to crash the process.
 */
import { db, quickLookupCache } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { openai } from '@workspace/integrations-openai-ai-server';
import { logger } from './logger';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT =
  'You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.';

const CHIPS = [
  {
    label: '1G',
    question:
      'What is a 1-gang electrical box, what devices does it hold, and what are the standard dimensions?',
  },
  {
    label: 'GFCI',
    question: 'What does GFCI stand for, how does it work, and where is it required by the NEC?',
  },
  {
    label: 'AFCI',
    question:
      'What is an AFCI breaker or receptacle, how does it work, and where does the NEC require it?',
  },
  {
    label: 'TRWR',
    question:
      'What does TRWR mean on a receptacle — what is Tamper Resistant and Weather Resistant, and where is each required?',
  },
  {
    label: 'Decora',
    question:
      'What is a Decora style switch or receptacle, who makes them, and how do they differ from standard toggle style?',
  },
  {
    label: 'Romex',
    question:
      'What is Romex (NM-B cable), what do the numbers on the sheath mean, and when is it allowed by code?',
  },
  {
    label: 'MC Cable',
    question:
      'What is MC cable (Metal Clad armored cable), how does it differ from Romex, and when should it be used?',
  },
  {
    label: 'EMT',
    question:
      'What is EMT (Electrical Metallic Tubing) conduit, what are its common uses, and how does it differ from rigid conduit?',
  },
  {
    label: 'Toggle vs Rocker',
    question:
      'What is the difference between a toggle switch and a rocker (paddle) switch — are they interchangeable?',
  },
  {
    label: 'Duplex',
    question:
      'What is a duplex receptacle, how does it differ from simplex and quadplex outlets, and what are standard amperage ratings?',
  },
  {
    label: '15A vs 20A',
    question:
      'What is the difference between 15 amp and 20 amp circuits, receptacles, and breakers — how do I tell them apart?',
  },
  {
    label: 'AWG',
    question:
      'What does AWG mean, how does wire gauge numbering work, and which gauge should I use for common circuits?',
  },
] as const;

async function fetchAnswer(question: string): Promise<string> {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_completion_tokens: 512,
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: question },
    ],
  });

  let fullText = '';
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) fullText += content;
  }
  return fullText;
}

export async function seedQuickLookups(): Promise<void> {
  logger.info('Quick lookup cache seeder starting');

  const staleThreshold = new Date(Date.now() - THIRTY_DAYS_MS);

  for (const chip of CHIPS) {
    try {
      const [existing] = await db
        .select()
        .from(quickLookupCache)
        .where(eq(quickLookupCache.label, chip.label))
        .limit(1);

      const isStale = !existing || existing.refreshedAt < staleThreshold;
      if (!isStale) {
        logger.debug({ label: chip.label }, 'Quick lookup cache hit — skipping');
        continue;
      }

      logger.info({ label: chip.label }, 'Fetching quick lookup answer from AI');
      const answer = await fetchAnswer(chip.question);

      if (!answer.trim()) {
        logger.warn({ label: chip.label }, 'AI returned empty answer — skipping upsert');
        continue;
      }

      await db
        .insert(quickLookupCache)
        .values({
          label: chip.label,
          question: chip.question,
          answer,
        })
        .onConflictDoUpdate({
          target: quickLookupCache.label,
          set: {
            question: chip.question,
            answer,
            refreshedAt: new Date(),
          },
        });

      logger.info({ label: chip.label }, 'Quick lookup cache upserted');
    } catch (err) {
      logger.error({ err, label: chip.label }, 'Failed to seed quick lookup — skipping');
    }
  }

  logger.info('Quick lookup cache seeder finished');
}
