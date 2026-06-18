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
 * If the startup probe logs a 404 for this name, try "Gemini-2.5-Pro" as a fallback.
 */
export const POE_CATALOG_BOT = "Gemini-3.1-Pro";

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
 */
export function getCatalogModel(): string {
  return _provider === "openai" ? "gpt-4o" : POE_CATALOG_BOT;
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

/**
 * Probe each Poe bot name with a minimal completion request.
 * Logs a clear warning for any bot that returns a 404 (renamed / retired)
 * or any other error (e.g. transient 500 from the provider).
 * Advisory only — the server always continues to start regardless of outcome.
 * No-op when the active provider is not "poe".
 */
export async function probePoeBotsOnStartup(): Promise<void> {
  if (_provider !== "poe") {
    return;
  }

  const botNames = getAllPoeModelNames();
  logger.info({ botNames }, "Probing Poe bot names on startup…");

  const PROBE_TIMEOUT_MS = 5000;

  try {
    await Promise.all(
      botNames.map(async (botName) => {
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
          logger.info({ botName }, `Poe bot '${botName}' — OK`);
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.message === "__PROBE_TIMEOUT__"
          ) {
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

          if (status === 404) {
            logger.warn(
              { botName },
              `Poe bot '${botName}' not found — check bot name in aiProvider.ts`,
            );
          } else {
            logger.warn(
              { botName, err },
              `Poe bot '${botName}' probe failed (status=${status ?? "unknown"}) — transient provider error, server will continue`,
            );
          }
        }
      }),
    );
  } catch (err) {
    logger.warn({ err }, "probePoeBotsOnStartup: unexpected error during probe — server will continue");
  }
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
