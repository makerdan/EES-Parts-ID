import { Router } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { screenViewLogTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

// POST /track/screen-view — public endpoint, fire-and-forget screen view logging.
// No auth required. Hashes req.ip for privacy-safe de-identification.
router.post("/screen-view", (req, res) => {
  const { screen } = req.body as { screen?: string };

  res.status(204).end();

  if (!screen?.trim()) return;

  const ip = req.ip ?? "unknown";
  const visitorHash = crypto.createHash("sha256").update(ip).digest("hex");

  setImmediate(async () => {
    try {
      await db.insert(screenViewLogTable).values({
        screenName: screen.trim(),
        visitorHash,
      });
    } catch (err) {
      logger.warn({ err }, "screen-view log insert failed");
    }
  });
});

export default router;
