import { Router } from "express";

import { getAllPoeModelNames, getProbeSummary, probePoeBotsOnStartup, probeSinglePoeBot } from "../lib/aiProvider";
import { logger } from "../lib/logger";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

// GET /admin/ai-status
// Returns the most recent per-bot probe results.
// Returns an empty bots object when provider is not "poe" or the probe has not run yet.
router.get("/ai-status", requireAdminAuth, (_req, res, next) => {
  try {
    return res.json({ bots: getProbeSummary() });
  } catch (err) {
    return void next(err);
  }
});

// POST /admin/ai-status/probe
// Re-runs probePoeBotsOnStartup() on demand and returns the refreshed results.
router.post("/ai-status/probe", requireAdminAuth, async (_req, res, next) => {
  try {
    await probePoeBotsOnStartup();
    return res.json({ bots: getProbeSummary() });
  } catch (err) {
    logger.error({ err }, "adminAiStatus: on-demand probe encountered an unexpected error");
    return void next(err);
  }
});

// POST /admin/ai-status/probe/:botName
// Re-probes a single named bot and returns the full refreshed summary.
// Returns 400 when the bot name is not in the known bot list.
router.post("/ai-status/probe/:botName", requireAdminAuth, async (req, res, next) => {
  try {
    const botName = req.params["botName"] as string;
    const knownBots = getAllPoeModelNames();
    if (!knownBots.includes(botName)) {
      return res.status(400).json({ error: `Unknown bot name: ${botName}` });
    }
    await probeSinglePoeBot(botName);
    return res.json({ bots: getProbeSummary() });
  } catch (err) {
    logger.error({ err }, "adminAiStatus: single-bot on-demand probe encountered an unexpected error");
    return void next(err);
  }
});

export default router;
