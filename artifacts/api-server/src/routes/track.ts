import crypto from "node:crypto";

import { db } from "@workspace/db";
import { screenViewLogTable } from "@workspace/db";
import { lt } from "drizzle-orm";
import { Router } from "express";

import { logger } from "../lib/logger";
import { screenViewLimiter } from "../lib/rateLimiter";

const router = Router();

// POST /track/screen-view — public endpoint, fire-and-forget screen view logging.
// No auth required. Hashes req.ip for privacy-safe de-identification.
router.post("/screen-view", async (req, res) => {
  const ip = req.ip ?? "unknown";
  const limitResult = await screenViewLimiter.check(ip);
  if (!limitResult.allowed) {
    return void res.status(429).json({
      error: "Too many requests. Please try again later.",
      retryAfterMs: limitResult.retryAfterMs,
    });
  }

  const { screen } = req.body as { screen?: string };

  res.status(204).end();

  if (!screen?.trim()) return;
  const visitorHash = crypto.createHash("sha256").update(ip).digest("hex");

  setImmediate(async () => {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await db.insert(screenViewLogTable).values({
        screenName: screen.trim(),
        visitorHash,
      });
      await db.delete(screenViewLogTable).where(lt(screenViewLogTable.createdAt, thirtyDaysAgo));
    } catch (err) {
      logger.warn({ err }, "screen-view log insert failed");
    }
  });
});

export default router;
