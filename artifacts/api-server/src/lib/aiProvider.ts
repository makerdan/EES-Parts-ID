/**
 * AI provider factory.
 *
 * Reads AI_PROVIDER ("poe" | "openai", default "poe") at startup and exports
 * a single OpenAI-compatible client plus per-provider model defaults.
 *
 * The active provider can be switched at runtime via setProvider() without
 * restarting the server — useful for hot-failover when one provider is down.
 *
 * Call initProvider() once during server startup to restore any persisted
 * provider choice from the database (takes priority over AI_PROVIDER env var).
 */

import { adminPreferencesTable,db } from "@workspace/db";
import { getPoeClient, listPoeModels, type PoeCatalogueModel,resetPoeClient } from "@workspace/integrations-poe-server";
import { eq } from "drizzle-orm";
import OpenAI from "openai";

import { logger } from "./logger";

export type AIProvider = "poe" | "openai";

const rawProvider = (process.env.AI_PROVIDER ?? "poe").toLowerCase();

if (rawProvider !== "poe" && rawProvider !== "openai") {
  throw new Error(
    `AI_PROVIDER must be "poe" or "openai", got "${rawProvider}"`,
  );
}

function buildOpenAIClient(): OpenAI {
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_BASE_URL must be set when AI_PROVIDER=openai. Did you forget to provision the OpenAI integration?",
    );
  }
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_API_KEY must be set when AI_PROVIDER=openai. Did you forget to provision the OpenAI integration?",
    );
  }
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

function buildClient(provider: AIProvider): OpenAI {
  return provider === "openai" ? buildOpenAIClient() : getPoeClient();
}

// ── Mutable runtime state ─────────────────────────────────────────────────────

let _provider: AIProvider = rawProvider as AIProvider;
// Lazily initialized on first call to getAiClient() — NOT at module load time.
// Eager initialization at module load throws if the required API key env var is
// missing, which fires uncaughtException → process.exit(1) before the HTTP
// server ever binds its port.  Deferring the build to first use means the
// server always starts; any missing key surfaces cleanly when an AI route is
// actually called (and validateEnv() will have already logged a clear warning).
let _client: OpenAI | null = null;

export type PoeFeature = "enrich" | "identify" | "dimensions" | "catalog";
export type PoeCatalogueFreshness = "fresh" | "stale" | "unavailable";
export type PoeProbeStatus = "ok" | "timeout" | "404" | "error";

export interface PoeFeatureRoute {
  feature: PoeFeature;
  primary: string;
  fallbacks: Array<string>;
  effective: Array<string>;
}

export interface PoeCatalogueSnapshot {
  freshness: PoeCatalogueFreshness;
  models: Array<PoeCatalogueModel>;
  fetchedAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
}

const _catalogue: {
  models: Array<PoeCatalogueModel>;
  fetchedAt: Date | null;
  lastSuccessAt: Date | null;
  freshness: PoeCatalogueFreshness;
  error: string | null;
} = {
  models: [],
  fetchedAt: null,
  lastSuccessAt: null,
  freshness: "unavailable",
  error: null,
};
let _catalogueRefreshInFlight: Promise<PoeCatalogueSnapshot> | null = null;
let _fallbackOverrides: Partial<Record<PoeFeature, Array<string>>> = {};

function snapshotCatalogue(): PoeCatalogueSnapshot {
  return {
    freshness: _catalogue.freshness,
    models: _catalogue.models.map((model) => ({
      ...model,
      modalities: [...model.modalities],
      capabilities: { ...model.capabilities },
    })),
    fetchedAt: _catalogue.fetchedAt?.toISOString() ?? null,
    lastSuccessAt: _catalogue.lastSuccessAt?.toISOString() ?? null,
    error: _catalogue.error,
  };
}

/**
 * Refresh the live catalogue once for all concurrent callers. A failed
 * refresh never discards a previously successful snapshot.
 */
export function refreshPoeCatalogue(): Promise<PoeCatalogueSnapshot> {
  if (_catalogueRefreshInFlight) return _catalogueRefreshInFlight;
  _catalogueRefreshInFlight = listPoeModels()
    .then((models) => {
      _catalogue.models = models;
      _catalogue.fetchedAt = new Date();
      _catalogue.lastSuccessAt = _catalogue.fetchedAt;
      _catalogue.freshness = "fresh";
      _catalogue.error = null;
      return snapshotCatalogue();
    })
    .catch((err: unknown) => {
      _catalogue.fetchedAt = new Date();
      _catalogue.freshness = _catalogue.lastSuccessAt ? "stale" : "unavailable";
      _catalogue.error = err instanceof Error ? err.message : String(err);
      return snapshotCatalogue();
    })
    .finally(() => {
      _catalogueRefreshInFlight = null;
    });
  return _catalogueRefreshInFlight;
}

export function getPoeCatalogueSnapshot(): PoeCatalogueSnapshot {
  return snapshotCatalogue();
}

function primaryForFeature(feature: PoeFeature): string {
  switch (feature) {
    case "enrich": return POE_ENRICH_BOT;
    case "identify": return POE_IDENTIFY_BOT;
    case "dimensions": return POE_DIMENSIONS_BOT;
    case "catalog": return _effectiveCatalogBotName;
  }
}

function requiredCapabilities(feature: PoeFeature): { text: boolean; vision: boolean; structuredOutput: boolean } {
  return {
    text: true,
    vision: feature !== "enrich",
    structuredOutput: true,
  };
}

function modelIsCompatible(feature: PoeFeature, modelName: string): boolean {
  const model = _catalogue.models.find((candidate) => candidate.id === modelName || candidate.name === modelName);
  if (!model) return false;
  const required = requiredCapabilities(feature);
  return Object.entries(required).every(([key, needed]) => {
    if (!needed) return true;
    const capability = model.capabilities[key as keyof typeof model.capabilities];
    if (capability === false) return false;
    if (capability === true) return true;
    return _botProbeResults.get(modelName) === "ok";
  });
}

function effectiveFallbacks(feature: PoeFeature): Array<string> {
  const configured = _fallbackOverrides[feature] ?? DEFAULT_FALLBACKS[feature];
  if (_catalogue.models.length === 0) return [...configured];
  return configured.filter((model) => modelIsCompatible(feature, model));
}

export function getPoeFeatureRoutes(): Array<PoeFeatureRoute> {
  return (["enrich", "identify", "dimensions", "catalog"] as Array<PoeFeature>).map((feature) => {
    const primary = primaryForFeature(feature);
    const fallbacks = effectiveFallbacks(feature).filter((model) => model !== primary);
    return { feature, primary, fallbacks, effective: [primary, ...fallbacks] };
  });
}

export function getPoeFallbackOverrides(): Partial<Record<PoeFeature, Array<string>>> {
  return Object.fromEntries(
    Object.entries(_fallbackOverrides).map(([feature, models]) => [feature, [...(models ?? [])]]),
  ) as Partial<Record<PoeFeature, Array<string>>>;
}

export function validatePoeFallbacks(
  feature: PoeFeature,
  models: unknown,
): { ok: true; models: Array<string> } | { ok: false; error: string } {
  if (!Array.isArray(models) || models.some((model) => typeof model !== "string" || !model.trim())) {
    return { ok: false, error: "fallbacks must be an array of model names" };
  }
  const primary = primaryForFeature(feature);
  const normalized = models.map((model) => model.trim());
  if (new Set(normalized).size !== normalized.length) {
    return { ok: false, error: "fallbacks must not contain duplicates" };
  }
  if (normalized.includes(primary)) {
    return { ok: false, error: "The code-configured primary model cannot be a fallback" };
  }
  if (_catalogue.models.length === 0) {
    return { ok: false, error: "Refresh the Poe catalogue before saving fallback models" };
  }
  const incompatible = normalized.find((model) => !modelIsCompatible(feature, model));
  if (incompatible) {
    return { ok: false, error: `${incompatible} is unavailable or lacks the capabilities required by ${feature}` };
  }
  return { ok: true, models: normalized };
}

export function setPoeFallbacks(feature: PoeFeature, models: unknown): { ok: true; models: Array<string> } | { ok: false; error: string } {
  const validated = validatePoeFallbacks(feature, models);
  if (!validated.ok) return validated;
  _fallbackOverrides = { ..._fallbackOverrides, [feature]: [...validated.models] };
  return validated;
}

export function resetPoeFallbacks(feature?: PoeFeature): void {
  if (!feature) {
    _fallbackOverrides = {};
    return;
  }
  const next = { ..._fallbackOverrides };
  delete next[feature];
  _fallbackOverrides = next;
}

function restorePoeFallbacks(value: unknown): void {
  if (!value || typeof value !== "object") {
    _fallbackOverrides = {};
    return;
  }
  const next: Partial<Record<PoeFeature, Array<string>>> = {};
  for (const feature of ["enrich", "identify", "dimensions", "catalog"] as Array<PoeFeature>) {
    const models = (value as Record<string, unknown>)[feature];
    if (Array.isArray(models) && models.every((model) => typeof model === "string")) {
      next[feature] = [...new Set(models as Array<string>)];
    }
  }
  _fallbackOverrides = next;
}

/**
 * Switch the active AI provider at runtime without restarting the server.
 * Throws if the required environment variables for the target provider are missing.
 */
export function setProvider(provider: AIProvider): void {
  if (provider === "poe") resetPoeClient();
  const next = buildClient(provider); // validate env vars first — may throw
  _provider = provider;
  _client = next;
}

/**
 * Read the persisted provider from the database and apply it.
 * Falls back to the AI_PROVIDER env var if no DB value exists.
 * Call once during server startup — errors are logged but do not crash the server.
 */
export async function initProvider(): Promise<void> {
  try {
    const rows = await db
      .select({
        aiProvider: adminPreferencesTable.aiProvider,
        aiFallbackModels: adminPreferencesTable.aiFallbackModels,
      })
      .from(adminPreferencesTable)
      .where(eq(adminPreferencesTable.id, 1))
      .limit(1);

    const persisted = rows[0]?.aiProvider;
    if (persisted === "poe" || persisted === "openai") {
      setProvider(persisted);
    }
    restorePoeFallbacks(rows[0]?.aiFallbackModels);
  } catch (err) {
    logger.warn({ err }, "initProvider: failed to read persisted AI provider from DB — falling back to env var default");
  }
}

/**
 * The currently active provider name.
 */
export function getProvider(): AIProvider {
  return _provider;
}

/**
 * OpenAI-compatible client pointed at the active provider.
 * Both Poe and OpenAI expose the same chat.completions API.
 *
 * Always read this getter at call-time — do NOT destructure once at module
 * load, because setProvider() replaces the underlying instance.
 * The client is built lazily on first call so that a missing API key env var
 * does not crash the server at module load time.
 */
export function getAiClient(): OpenAI {
  if (!_client) {
    _client = buildClient(_provider);
  }
  return _client;
}


// ── Poe bot name constants ─────────────────────────────────────────────────────

/**
 * Poe bot used for keyword enrichment and reference Q&A.
 * Uses Gemini-3.1-Pro — the same vision-capable model as the catalog chain,
 * so it also handles image-bearing enrich calls gracefully.
 */
export const POE_ENRICH_BOT = "Gemini-3.1-Pro";

/** Poe bot used for part identification from photos (vision capable). */
export const POE_IDENTIFY_BOT = "Claude-Sonnet-4.5";

/** Poe bot used for physical dimension estimation from photos (vision capable). */
export const POE_DIMENSIONS_BOT = "Claude-Sonnet-4.5";

/**
 * Poe bot used exclusively for catalog PDF extraction (vision capable, Gemini).
 * Name confirmed as "Gemini-3.1-Pro" — validated by probePoeBotsOnStartup() at boot.
 * If the startup probe detects a 404, probePoeBotsOnStartup() automatically switches
 * the effective catalog bot to POE_CATALOG_BOT_FALLBACK without requiring a redeploy.
 */
export const POE_CATALOG_BOT = "Gemini-3.1-Pro";

/**
 * Fallback Poe bot name for catalog PDF extraction.
 * Activated automatically by probePoeBotsOnStartup() when POE_CATALOG_BOT returns 404.
 */
export const POE_CATALOG_BOT_FALLBACK = "Gemini-2.5-Pro";

/**
 * Effective catalog bot name — starts as POE_CATALOG_BOT and may be updated to
 * POE_CATALOG_BOT_FALLBACK at runtime by probePoeBotsOnStartup() when a 404 is detected.
 * Always read via getCatalogModel() rather than this variable directly.
 */
let _effectiveCatalogBotName: string = POE_CATALOG_BOT;

const DEFAULT_FALLBACKS: Record<PoeFeature, Array<string>> = {
  enrich: [POE_IDENTIFY_BOT],
  identify: [POE_CATALOG_BOT],
  dimensions: [POE_CATALOG_BOT],
  catalog: [POE_IDENTIFY_BOT],
};

// ── Model defaults (re-derived at call time via helpers below) ────────────────

/**
 * Default model for keyword enrichment.
 * Reflects the currently active provider.
 */
export function getEnrichModel(): string {
  return _provider === "openai" ? "gpt-4o-mini" : POE_ENRICH_BOT;
}

/**
 * Default model for part identification (vision capable).
 * Reflects the currently active provider.
 */
export function getIdentifyModel(): string {
  return _provider === "openai" ? "gpt-4o" : POE_IDENTIFY_BOT;
}

/**
 * Default model for reference Q&A (same tier as enrichment — fast, cheap).
 * Reflects the currently active provider.
 */
export function getReferenceModel(): string {
  return getEnrichModel();
}

/**
 * Default model for catalog PDF extraction (Gemini vision — dedicated bot).
 * Reflects the currently active provider.
 * When provider is "poe", returns the effective catalog bot name — which may have
 * been automatically switched to POE_CATALOG_BOT_FALLBACK by probePoeBotsOnStartup()
 * if the primary bot returned 404 at startup.
 */
export function getCatalogModel(): string {
  return _provider === "openai" ? "gpt-4o" : _effectiveCatalogBotName;
}

/**
 * Default model for physical dimension estimation from photos (vision capable).
 * Reflects the currently active provider.
 */
export function getDimensionsModel(): string {
  return _provider === "openai" ? "gpt-5.1" : POE_DIMENSIONS_BOT;
}

/**
 * Return every distinct Poe bot name the app may call.
 * Used by probePoeBotsOnStartup() to validate names at boot time.
 */
export function getAllPoeModelNames(): Array<string> {
  const names = [
    POE_ENRICH_BOT,     // enrich / reference
    POE_IDENTIFY_BOT,   // identify (photo-based)
    POE_DIMENSIONS_BOT, // dimensions
    POE_CATALOG_BOT,    // catalog PDF extraction
    ..._catalogue.models.map((model) => model.name),
    ...getPoeFeatureRoutes().flatMap((route) => route.effective),
  ];
  return [...new Set(names)];
}

// ── Per-feature Poe bot chains ────────────────────────────────────────────────

/**
 * Identifies which Poe-backed feature a call belongs to.
 * Used by callPoeBotWithChain() and tryPoeBotChain() to resolve the ordered
 * fallback chain.
 */
/**
 * Returns the ordered list of Poe bot names to attempt for the given feature.
 * The primary bot is first; vision-capable alternates follow.
 * Uses the effective catalog bot name (may have been switched at startup by
 * probePoeBotsOnStartup() if POE_CATALOG_BOT returned 404).
 */
export function getPoeChainForFeature(feature: PoeFeature): Array<string> {
  return getPoeFeatureRoutes().find((route) => route.feature === feature)?.effective ?? [];
}

/**
 * Returns the model name for the given feature using the currently active
 * provider.  Used by tryPoeBotChain() when the active provider is not "poe"
 * so the same chain helper works for both Poe and OpenAI providers.
 */
export function getModelForFeature(feature: PoeFeature): string {
  switch (feature) {
    case "enrich":     return getEnrichModel();
    case "identify":   return getIdentifyModel();
    case "dimensions": return getDimensionsModel();
    case "catalog":    return getCatalogModel();
  }
}

/** OpenAI model names for each feature — always OpenAI regardless of provider. */
const OPENAI_FEATURE_MODELS: Record<PoeFeature, string> = {
  enrich: "gpt-4o-mini",
  identify: "gpt-4o",
  dimensions: "gpt-5.1",
  catalog: "gpt-4o",
};

/**
 * Return the OpenAI model name for the given feature.
 * Unlike getModelForFeature(), this always returns an OpenAI model name —
 * never a Poe bot name — so it is safe to use when constructing one-off
 * OpenAI fallback calls regardless of the active provider setting.
 */
export function getOpenAIModelForFeature(feature: PoeFeature): string {
  return OPENAI_FEATURE_MODELS[feature];
}

/**
 * Build a one-off OpenAI client using the Replit AI Integration credentials.
 * Used by routes that receive the x-use-openai-fallback request header to
 * serve a single request via OpenAI without flipping the global provider.
 * Throws if AI_INTEGRATIONS_OPENAI_BASE_URL / AI_INTEGRATIONS_OPENAI_API_KEY
 * are not set.
 */
export function getOpenAIFallbackClient(): OpenAI {
  return buildOpenAIClient();
}

/**
 * Like getOpenAIFallbackClient() but returns null instead of throwing when
 * AI_INTEGRATIONS_OPENAI_BASE_URL / AI_INTEGRATIONS_OPENAI_API_KEY are not
 * configured.  Use this when the Replit AI fallback is optional — callers
 * should re-throw the original error when null is returned.
 */
export function tryGetOpenAIFallbackClient(): OpenAI | null {
  if (
    !process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    !process.env.AI_INTEGRATIONS_OPENAI_API_KEY
  ) {
    return null;
  }
  return buildOpenAIClient();
}

// ── Per-bot probe results ─────────────────────────────────────────────────────

/** Result status for a single Poe bot startup probe. */
export type BotProbeStatus = "ok" | "timeout" | "404" | "error";

/** Map of bot name → probe result, populated by probePoeBotsOnStartup(). */
const _botProbeResults = new Map<string, BotProbeStatus>();

/**
 * Returns a snapshot of every bot that was probed at startup and its result.
 * Returns an empty object when the active provider is not "poe" or before the
 * first probe has completed.
 */
export function getProbeSummary(): Record<string, BotProbeStatus> {
  if (_provider !== "poe") return {};
  return Object.fromEntries(_botProbeResults);
}

/** Shared timeout budget for all Poe bot probes. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Probe a single Poe bot and update _botProbeResults for that bot.
 * Contains the full timeout + error-classification logic including the
 * catalog-bot fallback.  Callers must check _provider === "poe" first.
 */
async function _probeBotAndRecord(botName: string): Promise<void> {
  // Cleared in the finally below — if the race resolves before the timeout,
  // an uncancelled 15s timer would keep the process (and Jest workers) alive.
  let probeTimer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      probeTimer = setTimeout(
        () => reject(new Error(`__PROBE_TIMEOUT__`)),
        PROBE_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([
        getAiClient().chat.completions.create({
          model: botName,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 16,
        }),
        timeoutPromise,
      ]);
      _botProbeResults.set(botName, "ok");
      logger.info({ botName }, `Poe bot '${botName}' — OK`);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message === "__PROBE_TIMEOUT__"
      ) {
        _botProbeResults.set(botName, "timeout");
        logger.warn(
          { botName },
          `Poe bot '${botName}' probe timed out after ${PROBE_TIMEOUT_MS}ms — server will continue`,
        );
        return;
      }

      const status =
        err != null &&
        typeof err === "object" &&
        "status" in err &&
        typeof (err as { status: unknown }).status === "number"
          ? (err as { status: number }).status
          : undefined;

      if (status === 404 && botName === POE_CATALOG_BOT) {
        _botProbeResults.set(botName, "404");
        logger.warn(
          { botName, fallback: POE_CATALOG_BOT_FALLBACK },
          `Poe catalog bot '${botName}' not found — probing fallback '${POE_CATALOG_BOT_FALLBACK}'`,
        );
        try {
          await getAiClient().chat.completions.create({
            model: POE_CATALOG_BOT_FALLBACK,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 16,
          });
          _effectiveCatalogBotName = POE_CATALOG_BOT_FALLBACK;
          _botProbeResults.set(POE_CATALOG_BOT_FALLBACK, "ok");
          logger.info(
            { botName: POE_CATALOG_BOT_FALLBACK },
            `Poe catalog bot switched to fallback '${POE_CATALOG_BOT_FALLBACK}' — OK`,
          );
        } catch (fallbackErr: unknown) {
          const fallbackStatus =
            fallbackErr != null &&
            typeof fallbackErr === "object" &&
            "status" in fallbackErr &&
            typeof (fallbackErr as { status: unknown }).status === "number"
              ? (fallbackErr as { status: number }).status
              : undefined;
          _botProbeResults.set(
            POE_CATALOG_BOT_FALLBACK,
            fallbackStatus === 404 ? "404" : "error",
          );
          logger.warn(
            { botName: POE_CATALOG_BOT_FALLBACK, err: fallbackErr, status: fallbackStatus },
            `Poe catalog fallback bot '${POE_CATALOG_BOT_FALLBACK}' also unavailable (status=${fallbackStatus ?? "unknown"}) — catalog extraction may fail`,
          );
        }
      } else if (status === 404) {
        _botProbeResults.set(botName, "404");
        logger.warn(
          { botName },
          `Poe bot '${botName}' not found — check bot name in aiProvider.ts`,
        );
      } else {
        _botProbeResults.set(botName, "error");
        logger.warn(
          { botName, err },
          `Poe bot '${botName}' probe failed (status=${status ?? "unknown"}) — transient provider error, server will continue`,
        );
      }
    }
  } catch (err: unknown) {
    _botProbeResults.set(botName, "error");
    logger.warn(
      { botName, err },
      `Poe bot '${botName}' probe encountered an unexpected error — server will continue`,
    );
  } finally {
    if (probeTimer !== undefined) clearTimeout(probeTimer);
  }
}

/**
 * Re-probe a single named Poe bot and update _botProbeResults for it.
 * Use this for on-demand per-bot re-probes (e.g. the admin tap-to-refresh
 * chip feature).  Does not clear the full results map.
 * No-op when the active provider is not "poe".
 */
export async function probeSinglePoeBot(botName: string): Promise<void> {
  if (_provider !== "poe") return;
  await _probeBotAndRecord(botName);
}

/**
 * Probe each Poe bot name with a minimal completion request.
 * Logs a clear warning for any bot that returns a 404 (renamed / retired)
 * or any other error (e.g. transient 500 from the provider).
 * Advisory only — the server always continues to start regardless of outcome.
 * No-op when the active provider is not "poe".
 * Stores per-bot results in module-level state accessible via getProbeSummary().
 */
export async function probePoeBotsOnStartup(): Promise<void> {
  if (_provider !== "poe") {
    return;
  }

  const botNames = getAllPoeModelNames();
  _botProbeResults.clear();
  logger.info({ botNames }, "Probing Poe bot names on startup…");

  await Promise.all(botNames.map(_probeBotAndRecord));
}

