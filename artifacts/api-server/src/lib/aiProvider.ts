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
import {
  createPoeChatCompletionWithSettlement,
  getPoeClient,
  listPoeModels,
  type PoeCatalogueModel,
  resetPoeClient,
} from "@workspace/integrations-poe-server";
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
export type PoeProbeStatus = "ok" | "timeout" | "404" | "error" | "budget_limited";
export interface PoeProbeResult {
  status: PoeProbeStatus;
  verifiedAt: string | null;
}
export interface PoeProbeOperation {
  startedAt: string;
  finishedAt: string;
  requested: number;
  attempted: number;
  completed: number;
  budgetLimited: boolean;
}

export interface PoeFeatureRoute {
  feature: PoeFeature;
  primary: string;
  fallbacks: Array<string>;
  effective: Array<string>;
}

export interface PoeRouteContract {
  feature: PoeFeature;
  goal: string;
  requiredCapabilities: {
    text: boolean;
    vision: boolean;
    structuredOutput: boolean;
  };
  input: string;
  output: string;
  contextClass: "catalogue" | "warehouse" | "operational";
  privacy: "prompt_not_persisted";
  latencyTargetMs: number;
  costTarget: "low" | "medium" | "high";
  authorization: "authenticated" | "admin" | "internal";
  fallback: "replit_ai" | "next_verified_model" | "none";
}

export interface PoeVerifiedRouteSnapshot extends PoeFeatureRoute {
  endpoint: string;
  capturedAt: string;
  catalogueFetchedAt: string;
  models: Array<PoeCatalogueModel>;
  contract: PoeRouteContract;
}

class PoeRouteUnavailableError extends Error {
  readonly feature: PoeFeature;
  constructor(feature: PoeFeature, message = `No verified Poe route is available for ${feature}`) {
    super(message);
    this.name = "PoeRouteUnavailableError";
    this.feature = feature;
  }
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

const ROUTE_CONTRACTS: Record<PoeFeature, PoeRouteContract> = {
  identify: {
    feature: "identify",
    goal: "Identify electrical parts from bounded user-supplied images and context.",
    requiredCapabilities: { text: true, vision: true, structuredOutput: true },
    input: "1–10 validated image data URIs plus bounded optional context.",
    output: "AiIdentifyResponseSchema JSON.",
    contextClass: "warehouse",
    privacy: "prompt_not_persisted",
    latencyTargetMs: 30_000,
    costTarget: "medium",
    authorization: "authenticated",
    fallback: "next_verified_model",
  },
  enrich: {
    feature: "enrich",
    goal: "Expand inventory descriptions and extract searchable keywords.",
    requiredCapabilities: { text: true, vision: false, structuredOutput: true },
    input: "One bounded inventory description or help context.",
    output: "AiEnrichmentResponseSchema or bounded keyword array.",
    contextClass: "warehouse",
    privacy: "prompt_not_persisted",
    latencyTargetMs: 30_000,
    costTarget: "low",
    authorization: "admin",
    fallback: "replit_ai",
  },
  dimensions: {
    feature: "dimensions",
    goal: "Estimate physical dimensions from one validated image.",
    requiredCapabilities: { text: true, vision: true, structuredOutput: true },
    input: "One validated image data URI under the model-specific size limit.",
    output: "AiDimensionsResponseSchema JSON.",
    contextClass: "warehouse",
    privacy: "prompt_not_persisted",
    latencyTargetMs: 30_000,
    costTarget: "medium",
    authorization: "authenticated",
    fallback: "next_verified_model",
  },
  catalog: {
    feature: "catalog",
    goal: "Extract bounded parts and image regions from one catalog page.",
    requiredCapabilities: { text: true, vision: true, structuredOutput: true },
    input: "Page text and up to four validated page images.",
    output: "Validated catalog entry array.",
    contextClass: "catalogue",
    privacy: "prompt_not_persisted",
    latencyTargetMs: 30_000,
    costTarget: "high",
    authorization: "admin",
    fallback: "replit_ai",
  },
};

function modelIsCompatible(feature: PoeFeature, modelName: string): boolean {
  const model = _catalogue.models.find((candidate) => candidate.id === modelName || candidate.name === modelName);
  if (!model) return false;
  const required = requiredCapabilities(feature);
  return Object.entries(required).every(([key, needed]) => {
    if (!needed) return true;
    const capability = model.capabilities[key as keyof typeof model.capabilities];
    // Unknown live evidence fails closed. A successful probe cannot turn
    // undocumented capability into an approved route.
    return capability === true && model.capabilityConfidence !== "unknown";
  });
}

function canonicalModelId(modelName: string): string {
  return _catalogue.models.find(
    (candidate) => candidate.id === modelName || candidate.name === modelName,
  )?.id ?? modelName;
}

function effectiveFallbacks(feature: PoeFeature): Array<string> {
  const configured = _fallbackOverrides[feature] ?? DEFAULT_FALLBACKS[feature];
  if (_catalogue.models.length === 0) return [...configured];
  return configured.filter((model) => modelIsCompatible(feature, model));
}

export function getPoeFeatureRoutes(): Array<PoeFeatureRoute> {
  return (["enrich", "identify", "dimensions", "catalog"] as Array<PoeFeature>).map((feature) => {
    const primary = primaryForFeature(feature);
    const fallbacks = effectiveFallbacks(feature)
      .map(canonicalModelId)
      .filter((model) => model !== canonicalModelId(primary));
    return {
      feature,
      primary: canonicalModelId(primary),
      fallbacks,
      effective: [canonicalModelId(primary), ...fallbacks],
    };
  });
}

/**
 * Capture an immutable, exact-ID route immediately before a Poe request.
 * Stale catalogue data remains available for diagnostics but cannot dispatch.
 */
export function getVerifiedPoeRouteSnapshot(feature: PoeFeature): PoeVerifiedRouteSnapshot {
  if (_catalogue.freshness !== "fresh" || !_catalogue.fetchedAt) {
    throw new PoeRouteUnavailableError(feature, "Poe catalogue is not freshly verified");
  }
  const route = getPoeFeatureRoutes().find((candidate) => candidate.feature === feature);
  if (!route || route.effective.some((model) => !modelIsCompatible(feature, model))) {
    throw new PoeRouteUnavailableError(feature, "Poe route has no live model with the required capabilities");
  }
  const models = route.effective.map((modelName) => {
    const model = _catalogue.models.find((candidate) => candidate.id === modelName);
    if (!model) throw new PoeRouteUnavailableError(feature, `Poe model ${modelName} is not live`);
    return {
      ...model,
      modalities: [...model.modalities],
      capabilities: { ...model.capabilities },
      parameters: {
        maxCompletionTokens: model.parameters?.maxCompletionTokens ?? null,
        temperature: model.parameters?.temperature ?? null,
        responseFormat: model.parameters?.responseFormat ?? null,
      },
      limits: {
        maxInputTokens: model.limits?.maxInputTokens ?? null,
        maxOutputTokens: model.limits?.maxOutputTokens ?? null,
        maxImages: model.limits?.maxImages ?? null,
        maxImageBytes: model.limits?.maxImageBytes ?? null,
      },
      approvedUse: [...(model.approvedUse ?? [])],
      verification: {
        source: model.verification?.source ?? "unknown",
        owner: model.verification?.owner ?? "unknown",
        verifiedAt: model.verification?.verifiedAt ?? null,
      },
    };
  });
  return {
    ...route,
    effective: [...route.effective],
    fallbacks: [...route.fallbacks],
    endpoint: models[0]!.endpoint,
    capturedAt: new Date().toISOString(),
    catalogueFetchedAt: _catalogue.fetchedAt.toISOString(),
    models,
    contract: { ...ROUTE_CONTRACTS[feature], requiredCapabilities: { ...ROUTE_CONTRACTS[feature].requiredCapabilities } },
  };
}

export function getPoeRouteContracts(): Array<PoeRouteContract> {
  return (["enrich", "identify", "dimensions", "catalog"] as Array<PoeFeature>).map(
    (feature) => ({ ...ROUTE_CONTRACTS[feature], requiredCapabilities: { ...ROUTE_CONTRACTS[feature].requiredCapabilities } }),
  );
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
  if (_catalogue.freshness !== "fresh" || _catalogue.models.length === 0) {
    return { ok: false, error: "Refresh the Poe catalogue before saving fallback models" };
  }
  const incompatible = normalized.find((model) => !modelIsCompatible(feature, model));
  if (incompatible) return { ok: false, error: describeFallbackIncompatibility(feature, incompatible) };
  return { ok: true, models: normalized };
}

const CAPABILITY_LABELS: Record<keyof ReturnType<typeof requiredCapabilities>, string> = {
  text: "text",
  vision: "vision",
  structuredOutput: "structured output",
};

function describeFallbackIncompatibility(feature: PoeFeature, modelName: string): string {
  const boundedName = modelName.trim().slice(0, 128) || "Selected model";
  const model = _catalogue.models.find(
    (candidate) => candidate.id === modelName || candidate.name === modelName,
  );
  if (!model) {
    return `${boundedName} is unavailable for ${feature}: it is not in the current verified catalogue`;
  }

  const required = requiredCapabilities(feature);
  const missing = Object.entries(required)
    .filter(([key, needed]) => needed && model.capabilities[key as keyof typeof model.capabilities] !== true)
    .map(([key]) => CAPABILITY_LABELS[key as keyof typeof CAPABILITY_LABELS]);
  if (model.capabilityConfidence === "unknown" || missing.length === 0) {
    return `${boundedName} is unavailable for ${feature}: capability evidence is incomplete`;
  }
  return `${boundedName} is unavailable for ${feature}: missing required capabilities (${missing.join(", ")})`;
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
 * Name is code-owned. Explicit verification records availability without
 * changing the configured primary route.
 */
export const POE_CATALOG_BOT = "Gemini-3.1-Pro";

/**
 * Fallback Poe bot name for catalog PDF extraction.
 * Retained as a code-owned fallback option in the catalog route chain.
 */
export const POE_CATALOG_BOT_FALLBACK = "Gemini-2.5-Pro";

/**
 * Effective catalog bot name. Live verification never mutates routing.
 * Always read via getCatalogModel() rather than this variable directly.
 */
const _effectiveCatalogBotName: string = POE_CATALOG_BOT;

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
 * When provider is "poe", returns the code-owned effective catalog bot name.
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
 * Return every distinct Poe bot name present in active application route chains.
 */
export function getAllPoeModelNames(): Array<string> {
  const names = [
    POE_ENRICH_BOT,     // enrich / reference
    POE_IDENTIFY_BOT,   // identify (photo-based)
    POE_DIMENSIONS_BOT, // dimensions
    POE_CATALOG_BOT,    // catalog PDF extraction
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
 * Uses the code-owned effective catalog bot name.
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

// ── Explicit live-verification results ────────────────────────────────────────

const _botProbeResults = new Map<string, PoeProbeResult>();
let _lastProbeOperation: PoeProbeOperation | null = null;
let _bulkProbeInFlight: Promise<PoeProbeOperation | null> | null = null;
let _activeProbeRequests = 0;
const _probePermitWaiters: Array<{ grant: () => void; cancel: () => void }> = [];

export const POE_PROBE_MAX_MODELS = 8;
export const POE_PROBE_CONCURRENCY = 2;
export const POE_PROBE_TIMEOUT_MS = 10_000;
export const POE_PROBE_AGGREGATE_TIMEOUT_MS = 30_000;

async function acquireProbePermit(
  signal?: AbortSignal,
): Promise<() => void> {
  let acquiredFromQueue = false;
  if (_activeProbeRequests >= POE_PROBE_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          acquiredFromQueue = true;
          _activeProbeRequests += 1;
          signal?.removeEventListener("abort", waiter.cancel);
          resolve();
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          const index = _probePermitWaiters.indexOf(waiter);
          if (index >= 0) _probePermitWaiters.splice(index, 1);
          reject(Object.assign(new Error("Poe verification budget expired"), {
            name: "AbortError",
          }));
        },
      };
      if (signal?.aborted) waiter.cancel();
      else {
        _probePermitWaiters.push(waiter);
        signal?.addEventListener("abort", waiter.cancel, { once: true });
      }
    });
  }
  if (signal?.aborted) {
    throw Object.assign(new Error("Poe verification budget expired"), {
      name: "AbortError",
    });
  }
  if (!acquiredFromQueue) _activeProbeRequests += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _activeProbeRequests -= 1;
    _probePermitWaiters.shift()?.grant();
  };
}

async function runBoundedProbeRequest(
  botName: string,
  parentSignal?: AbortSignal,
): Promise<void> {
  const releasePermit = await acquireProbePermit(parentSignal);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort!: (err: Error) => void;
  const abort = () => {
    controller.abort();
    rejectAbort(Object.assign(new Error("Poe verification budget expired"), {
      name: "AbortError",
    }));
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(
        new Error(`Poe request timed out after ${POE_PROBE_TIMEOUT_MS}ms`),
        { name: "PoeProviderError", kind: "timeout" },
      ));
    }, POE_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  let response: Promise<unknown>;
  let transportSettled: Promise<void>;
  try {
    const handle = createPoeChatCompletionWithSettlement(
      {
        model: botName,
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 16,
      },
      { timeoutMs: POE_PROBE_TIMEOUT_MS, signal: controller.signal },
    );
    response = handle.response;
    transportSettled = handle.transportSettled;
  } catch (err) {
    releasePermit();
    throw err;
  }
  void transportSettled.then(releasePermit, releasePermit);
  try {
    await Promise.race([
      response,
      aborted,
      timedOut,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

export function getProbeSummary(): Record<string, PoeProbeStatus> {
  if (_provider !== "poe") return {};
  return Object.fromEntries(
    [..._botProbeResults].map(([name, result]) => [name, result.status]),
  );
}

export function getProbeVerificationSummary(): Record<string, PoeProbeResult> {
  if (_provider !== "poe") return {};
  return Object.fromEntries(
    [..._botProbeResults].map(([name, result]) => [name, { ...result }]),
  );
}

export function getLastProbeOperation(): PoeProbeOperation | null {
  return _lastProbeOperation ? { ..._lastProbeOperation } : null;
}

/**
 * Probe a single Poe bot and update _botProbeResults for that bot.
 * Contains the full timeout + error-classification logic including the
 * catalog-bot fallback.  Callers must check _provider === "poe" first.
 */
async function _probeBotAndRecord(
  botName: string,
  signal?: AbortSignal,
  results = _botProbeResults,
): Promise<void> {
  const record = (status: PoeProbeStatus) => {
    results.set(botName, {
      status,
      verifiedAt: status === "budget_limited" ? null : new Date().toISOString(),
    });
  };
  try {
    try {
      if (signal?.aborted) {
        record("budget_limited");
        return;
      }
      await runBoundedProbeRequest(botName, signal);
      record("ok");
      logger.info({ botName }, `Poe bot '${botName}' — OK`);
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        record("budget_limited");
        return;
      }
      if (
        err instanceof Error &&
        (err.name === "PoeProviderError" && "kind" in err && (err as { kind?: unknown }).kind === "timeout")
      ) {
        record("timeout");
        logger.warn(
          { botName },
          `Poe bot '${botName}' probe timed out after ${POE_PROBE_TIMEOUT_MS}ms`,
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

      if (status === 404) {
        record("404");
        logger.warn(
          { botName },
          `Poe bot '${botName}' not found — check bot name in aiProvider.ts`,
        );
      } else {
        record("error");
        logger.warn(
          { botName, err },
          `Poe bot '${botName}' probe failed (status=${status ?? "unknown"}) — transient provider error, server will continue`,
        );
      }
    }
  } catch (err: unknown) {
    record("error");
    logger.warn(
      { botName, err },
      `Poe bot '${botName}' probe encountered an unexpected error — server will continue`,
    );
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
  if (!getAllPoeModelNames().includes(botName)) {
    throw new Error(`Model is not in an active Poe route chain: ${botName}`);
  }
  if (_bulkProbeInFlight) {
    await _bulkProbeInFlight;
    if (_botProbeResults.has(botName)) return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POE_PROBE_AGGREGATE_TIMEOUT_MS);
  timer.unref?.();
  try {
    await _probeBotAndRecord(botName, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Explicit, administrator-triggered bulk verification. Only active route-chain
 * models are considered, with fixed count, concurrency, attempt, request-timeout,
 * and aggregate-deadline limits.
 */
export async function probeActivePoeModels(): Promise<PoeProbeOperation | null> {
  if (_provider !== "poe") return null;
  if (_bulkProbeInFlight) return _bulkProbeInFlight;
  _bulkProbeInFlight = (async () => {
    const allNames = getAllPoeModelNames();
    const botNames = allNames.slice(0, POE_PROBE_MAX_MODELS);
    const omitted = allNames.slice(POE_PROBE_MAX_MODELS);
    const nextResults = new Map<string, PoeProbeResult>();
    for (const name of omitted) {
      nextResults.set(name, { status: "budget_limited", verifiedAt: null });
    }
    const startedAt = new Date();
    const controller = new AbortController();
    let deadlineReached = false;
    let resolveDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => {
      resolveDeadline = resolve;
    });
    const timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort();
      resolveDeadline();
    }, POE_PROBE_AGGREGATE_TIMEOUT_MS);
    timer.unref?.();
    let cursor = 0;
    let attempted = 0;
    try {
      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = cursor++;
          const botName = botNames[index];
          if (!botName) return;
          attempted += 1;
          await _probeBotAndRecord(botName, controller.signal, nextResults);
        }
      };
      const workers = Promise.all(
        Array.from({ length: Math.min(POE_PROBE_CONCURRENCY, botNames.length) }, worker),
      );
      await Promise.race([workers, deadline]);
      if (deadlineReached) {
        void workers.catch((err: unknown) => {
          logger.warn({ err }, "Late Poe verification worker failed after aggregate deadline");
        });
      }
    } finally {
      clearTimeout(timer);
    }
    for (const name of botNames) {
      if (!nextResults.has(name)) {
        nextResults.set(name, { status: "budget_limited", verifiedAt: null });
      }
    }
    const completed = [...nextResults.values()]
      .filter((result) => result.verifiedAt !== null).length;
    const operation = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      requested: allNames.length,
      attempted,
      completed,
      budgetLimited: deadlineReached || omitted.length > 0 || completed < botNames.length,
    };
    _botProbeResults.clear();
    for (const [name, result] of nextResults) _botProbeResults.set(name, result);
    _lastProbeOperation = operation;
    return { ...operation };
  })().finally(() => {
    _bulkProbeInFlight = null;
  });
  return _bulkProbeInFlight;
}

