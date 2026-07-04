import crypto from "node:crypto";

import { db } from "@workspace/db";
import { referenceAnswerCacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import { logger } from "./logger";

/** Standard TTL for AI-only answers (3 days). */
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Shorter TTL for web-sourced answers (6 hours). */
const WEB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function normalizeQuestion(question: string): string {
  return question.toLowerCase().trim().replace(/\s+/g, " ");
}

export function hashQuestion(normalized: string): string {
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export async function getCachedAnswer(questionHash: string): Promise<string | null> {
  try {
    const rows = await db
      .select({
        answer: referenceAnswerCacheTable.answer,
        cachedAt: referenceAnswerCacheTable.cachedAt,
        usedWebSearch: referenceAnswerCacheTable.usedWebSearch,
      })
      .from(referenceAnswerCacheTable)
      .where(eq(referenceAnswerCacheTable.questionHash, questionHash))
      .limit(1);

    if (rows.length === 0) return null;

    const ttl = rows[0]!.usedWebSearch ? WEB_CACHE_TTL_MS : CACHE_TTL_MS;
    const cutoff = new Date(Date.now() - ttl);
    if (rows[0]!.cachedAt < cutoff) return null;

    return rows[0]!.answer;
  } catch (err) {
    logger.warn({ err }, "answer cache read failed — skipping cache");
    return null;
  }
}

export async function setCachedAnswer(
  questionHash: string,
  question: string,
  answer: string,
  usedWebSearch = false,
): Promise<void> {
  try {
    await db
      .insert(referenceAnswerCacheTable)
      .values({ questionHash, question, answer, cachedAt: new Date(), usedWebSearch })
      .onConflictDoUpdate({
        target: referenceAnswerCacheTable.questionHash,
        set: { answer, cachedAt: new Date(), usedWebSearch },
      });
  } catch (err) {
    logger.warn({ err }, "answer cache write failed");
  }
}

export async function invalidateReferenceAnswerCache(): Promise<void> {
  try {
    await db.delete(referenceAnswerCacheTable);
    logger.info("reference_answer_cache invalidated due to inventory update");
  } catch (err) {
    logger.warn({ err }, "reference_answer_cache invalidation failed");
  }
}
