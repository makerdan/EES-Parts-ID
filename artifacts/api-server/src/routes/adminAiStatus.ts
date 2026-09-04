import { GetAdminAiStatusResponse } from "@workspace/api-zod";
import { adminPreferencesTable, db } from "@workspace/db";
import type { Request, Response } from "express";
import { Router } from "express";

import {
  getAllPoeModelNames,
  getPoeCatalogueSnapshot,
  getPoeFallbackOverrides,
  getPoeFeatureRoutes,
  getProbeSummary,
  getProvider,
  type PoeFeature,
  probePoeBotsOnStartup,
  probeSinglePoeBot,
  refreshPoeCatalogue,
  resetPoeFallbacks,
  setPoeFallbacks,
  validatePoeFallbacks,
} from "../lib/aiProvider";
import { logger } from "../lib/logger";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

const EMPTY_CATALOGUE = {
  freshness: "unavailable" as const,
  models: [],
  fetchedAt: null,
  lastSuccessAt: null,
  error: null,
};

function getCatalogueSnapshotCompat() {
  return typeof getPoeCatalogueSnapshot === "function"
    ? getPoeCatalogueSnapshot()
    : EMPTY_CATALOGUE;
}

function getFeatureRoutesCompat() {
  return typeof getPoeFeatureRoutes === "function" ? getPoeFeatureRoutes() : [];
}

function getFallbackOverridesCompat() {
  return typeof getPoeFallbackOverrides === "function" ? getPoeFallbackOverrides() : {};
}

function statusPayload() {
  return {
    provider: getProvider(),
    catalogue: getCatalogueSnapshotCompat(),
    bots: getProbeSummary(),
    routes: getFeatureRoutesCompat(),
    overrides: getFallbackOverridesCompat(),
    reference: {
      provider: "gemini",
      readOnly: true,
      note: "Reference assistant remains Gemini-backed and is not configurable here.",
    },
  };
}

// GET /admin/ai-status
// Returns the most recent per-bot probe results.
// Returns an empty bots object when provider is not "poe" or the probe has not run yet.
router.get("/ai-status", requireAdminAuth, (_req, res, next) => {
  try {
    return res.json(GetAdminAiStatusResponse.parse(statusPayload()));
  } catch (err) {
    return void next(err);
  }
});

async function refreshCatalogue(_req: Request, res: Response, next: (err?: unknown) => void) {
  try {
    const snapshot = await refreshPoeCatalogue();
    const payload = statusPayload();
    if (snapshot.freshness === "unavailable") {
      return res.status(503).json(GetAdminAiStatusResponse.parse(payload));
    }
    return res.json(GetAdminAiStatusResponse.parse(payload));
  } catch (err) {
    logger.error({ err }, "adminAiStatus: catalogue refresh failed");
    return void next(err);
  }
}

router.post("/ai-status/catalogue/refresh", requireAdminAuth, refreshCatalogue);
// Short alias retained for clients that only expose a single refresh action.
router.post("/ai-status/refresh", requireAdminAuth, refreshCatalogue);

// POST /admin/ai-status/probe
// Re-runs probePoeBotsOnStartup() on demand and returns the refreshed results.
router.post("/ai-status/probe", requireAdminAuth, async (_req, res, next) => {
  try {
    await probePoeBotsOnStartup();
    return res.json(GetAdminAiStatusResponse.parse(statusPayload()));
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
    return res.json(GetAdminAiStatusResponse.parse(statusPayload()));
  } catch (err) {
    logger.error({ err }, "adminAiStatus: single-bot on-demand probe encountered an unexpected error");
    return void next(err);
  }
});

const FEATURES: Array<PoeFeature> = ["enrich", "identify", "dimensions", "catalog"];

function parseRouteUpdates(body: unknown): Array<[PoeFeature, unknown]> | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (typeof value.feature === "string") {
    if (!FEATURES.includes(value.feature as PoeFeature)) return null;
    return [[value.feature as PoeFeature, value.fallbacks ?? value.models]];
  }
  if (!value.routes || typeof value.routes !== "object") return null;
  return Object.entries(value.routes).map(([feature, models]) => [feature as PoeFeature, models]);
}

async function saveRoutes(req: Request, res: Response) {
  const updates = parseRouteUpdates(req.body);
  if (!updates || updates.length === 0 || updates.some(([feature]) => !FEATURES.includes(feature))) {
    return res.status(400).json({ error: "Provide routes for enrich, identify, dimensions, or catalog" });
  }

  const validated = updates.map(([feature, models]) => [feature, validatePoeFallbacks(feature, models)] as const);
  const invalid = validated.find(([, result]) => !result.ok);
  if (invalid && !invalid[1].ok) return res.status(400).json({ error: invalid[1].error });

  const nextOverrides = { ...getPoeFallbackOverrides() };
  for (const [feature, result] of validated) {
    if (result.ok) nextOverrides[feature] = result.models;
  }
  try {
    await db
      .insert(adminPreferencesTable)
      .values({ id: 1, aiFallbackModels: nextOverrides, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: adminPreferencesTable.id,
        set: { aiFallbackModels: nextOverrides, updatedAt: new Date() },
      });
    for (const [feature, result] of validated) {
      if (result.ok) setPoeFallbacks(feature, result.models);
    }
    return res.json(GetAdminAiStatusResponse.parse(statusPayload()));
  } catch (err) {
    logger.error({ err }, "adminAiStatus: fallback route save failed");
    return res.status(503).json({ error: "Fallback choices could not be saved; the previous routes remain active" });
  }
}

router.put("/ai-status/routes", requireAdminAuth, saveRoutes);
router.post("/ai-status/fallbacks", requireAdminAuth, saveRoutes);

async function resetRoutes(req: Request, res: Response) {
  const rawFeature = (req.body as { feature?: unknown } | undefined)?.feature;
  const feature = rawFeature === undefined ? undefined : rawFeature as PoeFeature;
  if (feature !== undefined && !FEATURES.includes(feature)) {
    return res.status(400).json({ error: "Unknown Poe feature" });
  }
  const nextOverrides = { ...getPoeFallbackOverrides() };
  if (feature) delete nextOverrides[feature];
  else for (const item of FEATURES) delete nextOverrides[item];
  try {
    await db
      .insert(adminPreferencesTable)
      .values({ id: 1, aiFallbackModels: Object.keys(nextOverrides).length ? nextOverrides : null, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: adminPreferencesTable.id,
        set: { aiFallbackModels: Object.keys(nextOverrides).length ? nextOverrides : null, updatedAt: new Date() },
      });
    resetPoeFallbacks(feature);
    return res.json(GetAdminAiStatusResponse.parse(statusPayload()));
  } catch (err) {
    logger.error({ err }, "adminAiStatus: fallback route reset failed");
    return res.status(503).json({ error: "Fallback choices could not be reset; the previous routes remain active" });
  }
}

router.post("/ai-status/routes/reset", requireAdminAuth, resetRoutes);

export default router;
