/**
 * Production environment variable validator.
 *
 * Call validateEnv() once at startup — before the server begins accepting
 * connections — to catch missing required vars early. In production the
 * function exits the process with a clear, actionable error message that
 * lists every missing variable. In development it is a no-op so local
 * workflows are never broken by an incomplete .env file.
 *
 * Keep this file in sync with the CORS and AI provider configuration in
 * app.ts and aiProvider.ts. When a new required-in-production var is added
 * to either file, add a corresponding entry here.
 */

import { logger } from "./logger";

interface EnvCheck {
  name: string;
  description: string;
  condition?: () => boolean;
}

const REQUIRED_IN_PRODUCTION: Array<EnvCheck> = [
  {
    name: "CORS_ALLOWED_ORIGINS",
    description:
      "Comma-separated list of allowed CORS origins (e.g. https://app.example.com). " +
      "Without this, all browser cross-origin requests are denied.",
  },
  {
    name: "POE_API_KEY2",
    description:
      "Poe API key required when AI_PROVIDER=poe (the default). " +
      "Without this, all AI features (identify, enrich, catalog) will fail.",
    condition: () => (process.env.AI_PROVIDER ?? "poe").toLowerCase() === "poe",
  },
  {
    name: "AI_INTEGRATIONS_OPENAI_BASE_URL",
    description:
      "OpenAI-compatible base URL required when AI_PROVIDER=openai. " +
      "Provision the OpenAI integration in Replit to obtain this value.",
    condition: () => (process.env.AI_PROVIDER ?? "poe").toLowerCase() === "openai",
  },
  {
    name: "AI_INTEGRATIONS_OPENAI_API_KEY",
    description:
      "OpenAI API key required when AI_PROVIDER=openai. " +
      "Provision the OpenAI integration in Replit to obtain this value.",
    condition: () => (process.env.AI_PROVIDER ?? "poe").toLowerCase() === "openai",
  },
];

/**
 * Validates that all required-in-production environment variables are present.
 *
 * - In production (NODE_ENV === "production"): exits with code 1 and a clear
 *   error message listing every missing variable if any are absent.
 * - In development: silently skips all checks so local workflows keep working.
 */
export function validateEnv(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const missing: Array<EnvCheck> = REQUIRED_IN_PRODUCTION.filter((check) => {
    if (check.condition && !check.condition()) {
      return false;
    }
    return !process.env[check.name];
  });

  if (missing.length === 0) {
    return;
  }

  const lines = missing.map(
    (check) => `  • ${check.name}\n      ${check.description}`,
  );

  logger.error(
    { missingVars: missing.map((c) => c.name) },
    [
      `Server cannot start — ${missing.length} required environment variable${missing.length === 1 ? " is" : "s are"} missing in production:`,
      ...lines,
      "Set the missing variables and redeploy.",
    ].join("\n"),
  );

  process.exit(1);
}
