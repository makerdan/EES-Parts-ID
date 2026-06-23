import { Router } from "express";
import { requireAdminAuth } from "./admin";
import { getProbeSummary, probePoeBotsOnStartup } from "../lib/aiProvider";
import { logger } from "../lib/logger";

const router = Router();

// GET /admin/ai-status
// Returns the most recent per-bot probe results.
// Returns an empty bots object when provider is not "poe" or the probe has not run yet.
router.get("/ai-status", requireAdminAuth, (_req, res) => {
  return res.json({ bots: getProbeSummary() });
});

// POST /admin/ai-status/probe
// Re-runs probePoeBotsOnStartup() on demand and returns the refreshed results.
// Advisory only — never throws; errors are logged and reflected in the returned summary.
router.post("/ai-status/probe", requireAdminAuth, async (_req, res) => {
  try {
    await probePoeBotsOnStartup();
  } catch (err) {
    logger.warn({ err }, "adminAiStatus: on-demand probe encountered an unexpected error");
  }
  return res.json({ bots: getProbeSummary() });
});

export default router;
