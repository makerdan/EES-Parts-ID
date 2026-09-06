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

import {
  CLIENT_PUBLIC_ENV_VARS,
  type EnvironmentSource,
  SERVER_ONLY_ENV_VARS,
} from "@workspace/db/runtime-data-boundary";

import { logger } from "./logger";
import { getScreenViewPrivacyReadiness } from "./screenViewPrivacy";

export interface EnvCheck {
  name: string;
  description: string;
  condition?: (env: EnvironmentSource) => boolean;
  isValid?: (value: string, env: EnvironmentSource) => boolean;
}

const REQUIRED_IN_PRODUCTION: Array<EnvCheck> = [
  {
    name: "DATABASE_ENV",
    description:
      "Explicit Replit database target. Production API processes must use DATABASE_ENV=production.",
    isValid: (value) => value.trim().toLowerCase() === "production",
  },
  {
    name: "DATABASE_URL",
    description:
      "Replit-provided PostgreSQL connection string used only by server-side packages.",
  },
  {
    name: "CLERK_PUBLISHABLE_KEY",
    description:
      "Clerk publishable key used by the API server to resolve the configured Clerk instance.",
  },
  {
    name: "CLERK_SECRET_KEY",
    description:
      "Clerk secret key used server-side to verify sessions and call Clerk's Backend API.",
  },
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
    condition: (env) => (env.AI_PROVIDER ?? "poe").toLowerCase() === "poe",
  },
  {
    name: "AI_INTEGRATIONS_OPENAI_BASE_URL",
    description:
      "OpenAI-compatible base URL required when AI_PROVIDER=openai. " +
      "Provision the OpenAI integration in Replit to obtain this value.",
    condition: (env) =>
      (env.AI_PROVIDER ?? "poe").toLowerCase() === "openai",
  },
  {
    name: "AI_INTEGRATIONS_OPENAI_API_KEY",
    description:
      "OpenAI API key required when AI_PROVIDER=openai. " +
      "Provision the OpenAI integration in Replit to obtain this value.",
    condition: (env) =>
      (env.AI_PROVIDER ?? "poe").toLowerCase() === "openai",
  },
];

export function getMissingProductionEnvVars(
  env: EnvironmentSource = process.env,
): Array<EnvCheck> {
  return REQUIRED_IN_PRODUCTION.filter((check) => {
    if (check.condition && !check.condition(env)) {
      return false;
    }
    const value = env[check.name];
    return !value?.trim() || (check.isValid ? !check.isValid(value, env) : false);
  });
}

export function getEnvironmentContract() {
  return {
    serverOnly: [...SERVER_ONLY_ENV_VARS],
    clientPublic: [...CLIENT_PUBLIC_ENV_VARS],
    productionRequired: REQUIRED_IN_PRODUCTION.map((check) => check.name),
  } as const;
}

export function formatMissingProductionEnvError(
  missing: ReadonlyArray<EnvCheck>,
): string {
  const lines = missing.map(
    (check) => `  • ${check.name}\n      ${check.description}`,
  );

  return [
    `Server cannot start — ${missing.length} required environment variable${missing.length === 1 ? " is" : "s are"} missing or invalid in production:`,
    ...lines,
    "Set the listed variables correctly in Replit Secrets or the deployment environment and redeploy.",
  ].join("\n");
}

/**
 * Validates that all required-in-production environment variables are present
 * and satisfy any value constraints.
 *
 * - In production (NODE_ENV === "production"): exits with code 1 and a clear
 *   error message listing every invalid variable if any are absent or invalid.
 * - In development: silently skips all checks so local workflows keep working.
 */
export function validateEnv(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const privacyReadiness = getScreenViewPrivacyReadiness();
  logger.info(
    {
      privacyKeyMaterialConfigured: privacyReadiness.privacyKeyMaterialConfigured,
      productionCorsConfigured: privacyReadiness.productionCorsConfigured,
      uniqueVisitorReportingAvailable:
        privacyReadiness.uniqueVisitorReportingAvailable,
    },
    "Production visitor-privacy reporting readiness",
  );
  if (!privacyReadiness.privacyKeyMaterialConfigured) {
    logger.warn(
      "Server-held privacy key material is not configured — unique-visitor reporting is disabled; no unkeyed fallback will be used.",
    );
  }

  const missing = getMissingProductionEnvVars();

  if (missing.length === 0) {
    return;
  }

  logger.error(
    { missingVars: missing.map((c) => c.name) },
    formatMissingProductionEnvError(missing),
  );

  process.exit(1);
}
