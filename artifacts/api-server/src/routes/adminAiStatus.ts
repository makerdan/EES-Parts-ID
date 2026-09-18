import { GetAdminAiStatusResponse } from "@workspace/api-zod";
import { adminPreferencesTable, db } from "@workspace/db";
import type { Request, Response } from "express";
import { Router } from "express";

import {
  getAllPoeModelNames,
  getLastProbeOperation,
  getPoeFallbackOverrides,
  getPoeFeatureRoutes,
  getPoeRegistrySnapshot,
  getProbeSummary,
  getProbeVerificationSummary,
  getProvider,
  type PoeFeature,
  probeActivePoeModels,
  probeSinglePoeBot,
  resetPoeFallbacks,
  setPoeFallbacks,
  validatePoeFallbacks,
} from "../lib/aiProvider";
import { logger } from "../lib/logger";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

const EMPTY_REGISTRY = {
  source: "configured_registry" as const,
  version: "static-v1",
  models: [],
};

function getRegistrySnapshotCompat() {
  return typeof getPoeRegistrySnapshot === "function"
    ? getPoeRegistrySnapshot()
    : EMPTY_REGISTRY;
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
    registry: getRegistrySnapshotCompat(),
    bots: getProbeSummary(),
    verification: {
      models: getProbeVerificationSummary(),
      lastOperation: getLastProbeOperation(),
    },
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

function retiredCatalogueRefresh(_req: Request, res: Response) {
  return res.status(410).json({
    error: "Poe catalogue discovery has been retired; the configured registry is shown in this status response",
  });
}

router.post("/ai-status/catalogue/refresh", requireAdminAuth, retiredCatalogueRefresh);
// Short alias retained for clients that only expose a single refresh action.
router.post("/ai-status/refresh", requireAdminAuth, retiredCatalogueRefresh);

// POST /admin/ai-status/probe
// Explicitly verifies the bounded set of active route-chain models.
router.post("/ai-status/probe", requireAdminAuth, async (_req, res, next) => {
  try {
    await probeActivePoeModels();
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
