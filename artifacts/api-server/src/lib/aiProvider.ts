/**
 * AI provider factory.
 *
 * Reads AI_PROVIDER ("poe" | "openai", default "poe") at startup and exports
 * a single OpenAI-compatible client plus per-provider model defaults.
 *
 * Switching providers requires only an env-var change — no code change or
 * redeploy of application code is needed.
 */

import OpenAI from "openai";

const rawProvider = (process.env.AI_PROVIDER ?? "poe").toLowerCase();

if (rawProvider !== "poe" && rawProvider !== "openai") {
  throw new Error(
    `AI_PROVIDER must be "poe" or "openai", got "${rawProvider}"`,
  );
}

export const AI_PROVIDER = rawProvider as "poe" | "openai";

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

/**
 * OpenAI-compatible client pointed at the active provider.
 * Both Poe and OpenAI expose the same chat.completions API.
 */
export const aiClient: OpenAI =
  AI_PROVIDER === "openai" ? buildOpenAIClient() : buildPoeClient();

/**
 * Default model for keyword enrichment (ENRICH_MODEL).
 * Override per-call by passing a model argument to generateKeywords().
 */
export const ENRICH_MODEL =
  AI_PROVIDER === "openai" ? "gpt-4o-mini" : "GPT-5-mini";

/**
 * Default model for part identification (vision capable).
 */
export const IDENTIFY_MODEL = AI_PROVIDER === "openai" ? "gpt-4o" : "GPT-4o";
