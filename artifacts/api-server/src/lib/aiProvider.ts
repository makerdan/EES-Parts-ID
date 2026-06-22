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

import OpenAI from "openai";
import { db, adminPreferencesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export type AIProvider = "poe" | "openai";

const rawProvider = (process.env.AI_PROVIDER ?? "poe").toLowerCase();

if (rawProvider !== "poe" && rawProvider !== "openai") {
  throw new Error(
    `AI_PROVIDER must be "poe" or "openai", got "${rawProvider}"`,
  );
}

function buildPoeClient(): OpenAI {
  if (!process.env.POE_API_KEY2) {
    throw new Error(
      "POE_API_KEY2 must be set when AI_PROVIDER=poe. Did you forget to add the Poe API key secret?",
    );
  }
  return new OpenAI({
    apiKey: process.env.POE_API_KEY2,
    baseURL: "https://api.poe.com/v1",
  });
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
  return provider === "openai" ? buildOpenAIClient() : buildPoeClient();
}

// ── Mutable runtime state ─────────────────────────────────────────────────────

let _provider: AIProvider = rawProvider as AIProvider;
let _client: OpenAI = buildClient(_provider);

/**
 * Switch the active AI provider at runtime without restarting the server.
 * Throws if the required environment variables for the target provider are missing.
 */
export function setProvider(provider: AIProvider): void {
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
      .select({ aiProvider: adminPreferencesTable.aiProvider })
      .from(adminPreferencesTable)
      .where(eq(adminPreferencesTable.id, 1))
      .limit(1);

    const persisted = rows[0]?.aiProvider;
    if (persisted === "poe" || persisted === "openai") {
      setProvider(persisted);
    }
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
 */
export function getAiClient(): OpenAI {
  return _client;
}

/**
 * @deprecated Use getAiClient() so the reference stays live after setProvider().
 */
export const aiClient: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop) {
    return (_client as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * @deprecated Use getProvider() for a live value.
 */
export const AI_PROVIDER: AIProvider = _provider;

// ── Poe bot name constants ─────────────────────────────────────────────────────

/** Poe bot used for keyword enrichment and reference Q&A (fast, cheap). */
export const POE_ENRICH_BOT = "GPT-5-Mini";

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
export function getAllPoeModelNames(): string[] {
  return [
    POE_ENRICH_BOT,     // enrich / reference
    POE_IDENTIFY_BOT,   // identify (photo-based)
    POE_DIMENSIONS_BOT, // dimensions
    POE_CATALOG_BOT,    // catalog PDF extraction
  ];
}

// ── Per-feature Poe bot chains ────────────────────────────────────────────────

/**
 * Identifies which Poe-backed feature a call belongs to.
 * Used by callPoeBotWithChain() and tryPoeBotChain() to resolve the ordered
 * fallback chain.
 */
export type PoeFeature = "enrich" | "identify" | "dimensions" | "catalog";

/**
 * Vision-capable features whose chains must never include POE_ENRICH_BOT.
 * GPT-5-Mini does not support inline image content and returns an HTTP 500 for
 * any base64 image payload — including small ones.
 */
const VISION_FEATURES: PoeFeature[] = ["identify", "dimensions", "catalog"];

/**
 * Assert that POE_ENRICH_BOT (GPT-5-Mini) does not appear in any vision chain.
 *
 * GPT-5-Mini does not support inline image content. If it were placed in a
 * vision chain it would silently fail every real call with an HTTP 500 from the
 * provider. This guard turns that silent failure into a loud error at startup so
 * the bug is caught before any user request reaches the affected route.
 *
 * Throws an Error listing every violation found.
 * No-op when there are no violations.
 *
 * @param chainGetter - Optional override for the chain resolver; defaults to
 *   `getPoeChainForFeature`. Provide a custom function in unit tests to simulate
 *   a misconfigured chain without monkey-patching module internals.
 */
export function assertVisionChainInvariants(
  chainGetter: (feature: PoeFeature) => string[] = getPoeChainForFeature,
): void {
  const violations: string[] = [];

  for (const feature of VISION_FEATURES) {
    const chain = chainGetter(feature);
    if (chain.includes(POE_ENRICH_BOT)) {
      violations.push(
        `"${feature}" chain contains POE_ENRICH_BOT (${POE_ENRICH_BOT}) at position ${chain.indexOf(POE_ENRICH_BOT)}`,
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Vision chain invariant violated — GPT-5-Mini must not appear in vision chains:\n` +
        violations.map((v) => `  • ${v}`).join("\n") +
        `\nFix: remove POE_ENRICH_BOT from the offending chain(s) in getPoeChainForFeature().`,
    );
  }
}

/**
 * Returns the ordered list of Poe bot names to attempt for the given feature.
 * The primary bot is first; vision-capable alternates follow.
 * Uses the effective catalog bot name (may have been switched at startup by
 * probePoeBotsOnStartup() if POE_CATALOG_BOT returned 404).
 *
 * Note: GPT-5-Mini (POE_ENRICH_BOT) is intentionally excluded from the
 * `identify`, `dimensions`, and `catalog` chains because it does NOT support
 * inline image content — HTTP 500 "Error from provider: openai and llm:
 * gpt-5-mini-2025" is returned for any base64 image regardless of size
 * (confirmed by probe 2026-06-22, documented in poeModelLimits.ts).
 * It remains valid for the text-only `enrich` feature.
 */
export function getPoeChainForFeature(feature: PoeFeature): string[] {
  const catalogBot = _effectiveCatalogBotName;
  switch (feature) {
    case "enrich":
      return [POE_ENRICH_BOT, POE_IDENTIFY_BOT, catalogBot];
    case "identify":
      return [POE_IDENTIFY_BOT, catalogBot];
    case "dimensions":
      return [POE_DIMENSIONS_BOT, catalogBot];
    case "catalog":
      return [catalogBot, POE_IDENTIFY_BOT];
  }
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

  // Fail loudly before making any network calls if a chain invariant is broken.
  assertVisionChainInvariants();

  const botNames = getAllPoeModelNames();
  _botProbeResults.clear();
  logger.info({ botNames }, "Probing Poe bot names on startup…");

  const PROBE_TIMEOUT_MS = 5000;

  await Promise.all(
    botNames.map(async (botName) => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`__PROBE_TIMEOUT__`)),
            PROBE_TIMEOUT_MS,
          ),
        );

        try {
          await Promise.race([
            _client.chat.completions.create({
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
              await _client.chat.completions.create({
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
      }
    }),
  );
}

/**
 * @deprecated Use getEnrichModel() so the value updates after setProvider().
 */
export const ENRICH_MODEL: string = _provider === "openai" ? "gpt-4o-mini" : POE_ENRICH_BOT;

/**
 * @deprecated Use getIdentifyModel() so the value updates after setProvider().
 */
export const IDENTIFY_MODEL: string = _provider === "openai" ? "gpt-4o" : POE_IDENTIFY_BOT;

/**
 * @deprecated Use getReferenceModel() so the value updates after setProvider().
 */
export const REFERENCE_MODEL: string = ENRICH_MODEL;

/**
 * @deprecated Use getCatalogModel() so the value updates after setProvider().
 */
export const CATALOG_MODEL: string = _provider === "openai" ? "gpt-4o" : POE_CATALOG_BOT;

/**
 * @deprecated Use getDimensionsModel() so the value updates after setProvider().
 */
export const DIMENSIONS_MODEL: string = _provider === "openai" ? "gpt-5.1" : POE_DIMENSIONS_BOT;
