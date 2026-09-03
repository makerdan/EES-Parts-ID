import { ScreenViewEventSchema } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { screenViewLogTable } from "@workspace/db";
import { Router } from "express";

import { logger } from "../lib/logger";
import { screenViewLimiter } from "../lib/rateLimiter";
import {
  deriveRotatingVisitorHash,
  getScreenViewRateLimitKey,
} from "../lib/screenViewPrivacy";

const router = Router();

// POST /track/screen-view — public, fire-and-forget screen view logging.
// The event contract is intentionally finite and rejects all client identifiers.
router.post("/screen-view", async (req, res) => {
  const ip = req.ip ?? "unknown";
  const limitResult = await screenViewLimiter.check(getScreenViewRateLimitKey(ip));
  if (!limitResult.allowed) {
    return void res.status(429).json({
      error: "Too many requests. Please try again later.",
      retryAfterMs: limitResult.retryAfterMs,
    });
  }

  const parsed = ScreenViewEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({
      error: "Invalid screen-view event",
      code: "INVALID_SCREEN_EVENT",
    });
  }

  res.status(204).end();

  const { screen } = parsed.data;
  const visitorHash = deriveRotatingVisitorHash(ip);

  setImmediate(async () => {
    try {
      await db.insert(screenViewLogTable).values({
        screenName: screen,
        visitorHash,
      });
    } catch (err) {
      logger.warn({ err }, "screen-view log insert failed");
    }
  });
});

export default router;
