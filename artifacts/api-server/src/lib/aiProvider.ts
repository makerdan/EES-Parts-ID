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
  if (!process.env.POE_API_KEY) {
    throw new Error(
      "POE_API_KEY must be set when AI_PROVIDER=poe. Did you forget to add the Poe API key secret?",
    );
  }
  return new OpenAI({
    apiKey: process.env.POE_API_KEY,
    baseURL: "https://api.poe.com/bot/",
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

// ── Model defaults (re-derived at call time via helpers below) ────────────────

/**
 * Default model for keyword enrichment.
 * Reflects the currently active provider.
 */
export function getEnrichModel(): string {
  return _provider === "openai" ? "gpt-4o-mini" : "GPT-5-mini";
}

/**
 * Default model for part identification (vision capable).
 * Reflects the currently active provider.
 */
export function getIdentifyModel(): string {
  return _provider === "openai" ? "gpt-4o" : "GPT-4o";
}

/**
 * Default model for reference Q&A (same tier as enrichment — fast, cheap).
 * Reflects the currently active provider.
 */
export function getReferenceModel(): string {
  return getEnrichModel();
}

/**
 * Default model for catalog PDF extraction (vision capable — same tier as identify).
 * Reflects the currently active provider.
 */
export function getCatalogModel(): string {
  return getIdentifyModel();
}

/**
 * Default model for physical dimension estimation from photos (vision capable).
 * Reflects the currently active provider.
 */
export function getDimensionsModel(): string {
  return _provider === "openai" ? "gpt-5.1" : "GPT-5.1";
}

/**
 * @deprecated Use getEnrichModel() so the value updates after setProvider().
 */
export const ENRICH_MODEL: string = _provider === "openai" ? "gpt-4o-mini" : "GPT-5-mini";

/**
 * @deprecated Use getIdentifyModel() so the value updates after setProvider().
 */
export const IDENTIFY_MODEL: string = _provider === "openai" ? "gpt-4o" : "GPT-4o";

/**
 * @deprecated Use getReferenceModel() so the value updates after setProvider().
 */
export const REFERENCE_MODEL: string = ENRICH_MODEL;

/**
 * @deprecated Use getCatalogModel() so the value updates after setProvider().
 */
export const CATALOG_MODEL: string = IDENTIFY_MODEL;

/**
 * @deprecated Use getDimensionsModel() so the value updates after setProvider().
 */
export const DIMENSIONS_MODEL: string = _provider === "openai" ? "gpt-5.1" : "GPT-5.1";
