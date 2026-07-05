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

/**
 * Compute a cache key for a question.
 *
 * When `history` is provided (a follow-up turn), a stable fingerprint of the
 * conversation is mixed into the hash so the resulting key is ALWAYS different
 * from the cold-start key for the same question text. This is the primary
 * structural defense against cache poisoning: even if the `!hasHistory` write
 * guard in reference.ts is accidentally removed in the future, a history-aware
 * answer can never overwrite — or be served as — a cold-start answer because
 * the two hashes occupy disjoint key spaces.
 *
 * When `isAdmin` is true, an admin sentinel is mixed into the hash so that
 * admin-aware answers (which may contain admin-only app knowledge) occupy a
 * key space disjoint from non-admin answers. This guarantees a cached admin
 * answer can never be served to a non-admin, and vice versa.
 *
 * Cold-start (non-admin):  sha256(normalized)
 * Cold-start (admin):      sha256(normalized + NUL + "admin" + NUL)
 * With history:            sha256(normalized + NUL + "history" + NUL + fingerprint [+ admin sentinel])
 */
export function hashQuestion(
  normalized: string,
  history?: Array<{ q: string; a: string }>,
  isAdmin = false,
): string {
  const hasher = crypto.createHash("sha256");
  hasher.update(normalized);
  if (history && history.length > 0) {
    // Each turn is separated by U+0000 (NUL) so that {"q":"a","a":"b c"} and
    // {"q":"a b","a":"c"} produce different fingerprints. Turns are delimited
    // by U+0001 (SOH). A sentinel prefix marks this as a history-keyed hash.
    const fingerprint = history
      .map((h) => `${h.q.trim()}\u0000${h.a.trim()}`)
      .join("\u0001");
    hasher.update("\u0000history\u0000");
    hasher.update(fingerprint);
  }
  if (isAdmin) {
    // Admin sentinel keeps admin and non-admin answers in disjoint key spaces.
    hasher.update("\u0000admin\u0000");
  }
  return hasher.digest("hex");
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
