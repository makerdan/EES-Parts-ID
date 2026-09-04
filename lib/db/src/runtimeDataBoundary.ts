/**
 * Runtime data-boundary contract.
 *
 * This module deliberately has no database imports. It is safe for server
 * entrypoints to load before the database pool is created, but it must never
 * be imported by a client package.
 */

export type DatabaseEnvironment = "development" | "test" | "production";
export type DatabaseOperation =
  | "application"
  | "test"
  | "seed"
  | "schema-sync";

export type EnvironmentSource = Readonly<
  Record<string, string | undefined>
>;

export const SERVER_ONLY_ENV_VARS = [
  "DATABASE_URL",
  "DATABASE_ENV",
  "AI_PROVIDER",
  "CORS_ALLOWED_ORIGINS",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "AI_INTEGRATIONS_GEMINI_API_KEY",
  "AI_INTEGRATIONS_GEMINI_BASE_URL",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
  "POE_API_KEY2",
  "DEFAULT_OBJECT_STORAGE_BUCKET_ID",
  "PRIVATE_OBJECT_DIR",
  "SESSION_SECRET",
] as const;

export const CLIENT_PUBLIC_ENV_VARS = [
  "EXPO_PUBLIC_API_BASE",
  "EXPO_PUBLIC_APP_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_PROXY_URL",
  "EXPO_PUBLIC_DOMAIN",
  "EXPO_PUBLIC_REPL_ID",
] as const;

const DATABASE_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "development",
  "test",
  "production",
]);

function getEnvironmentSource(
  env: EnvironmentSource = process.env,
): EnvironmentSource {
  return env;
}

/**
 * Reads the explicit database target. There is intentionally no implicit
 * fallback: a caller that can mutate data must identify its target first.
 */
export function getDatabaseEnvironment(
  env: EnvironmentSource = process.env,
): DatabaseEnvironment {
  const value = getEnvironmentSource(env).DATABASE_ENV?.trim().toLowerCase();

  if (!value || !DATABASE_ENVIRONMENTS.has(value)) {
    throw new Error(
      "DATABASE_ENV must be set to one of: development, test, production.",
    );
  }

  return value as DatabaseEnvironment;
}

function expectedApplicationEnvironment(
  env: EnvironmentSource,
): DatabaseEnvironment {
  if (env.NODE_ENV === "production") return "production";
  if (env.NODE_ENV === "test" || env.JEST_WORKER_ID) return "test";
  return "development";
}

/**
 * Fails closed when a database is used by the wrong kind of process.
 *
 * In particular, production is never accepted by tests, seed scripts, or
 * schema synchronization. Application startup also requires NODE_ENV and
 * DATABASE_ENV to describe the same target.
 */
export function assertDatabaseExecutionMode(
  operation: DatabaseOperation,
  env: EnvironmentSource = process.env,
): DatabaseEnvironment {
  const databaseEnvironment = getDatabaseEnvironment(env);

  if (operation === "application") {
    const expected = expectedApplicationEnvironment(env);
    if (databaseEnvironment !== expected) {
      throw new Error(
        `DATABASE_ENV does not match the application runtime (${expected}).`,
      );
    }
    return databaseEnvironment;
  }

  if (operation === "test" && databaseEnvironment !== "test") {
    throw new Error(
      "Test execution requires DATABASE_ENV=test; refusing to access another database.",
    );
  }

  if (
    (operation === "seed" || operation === "schema-sync") &&
    databaseEnvironment === "production"
  ) {
    throw new Error(
      `${operation === "seed" ? "Seed" : "Schema synchronization"} commands cannot target DATABASE_ENV=production.`,
    );
  }

  return databaseEnvironment;
}

/**
 * Return only values explicitly approved for client configuration.
 *
 * This is used by build tooling and is intentionally not exported through a
 * client-facing workspace package.
 */
export function getClientPublicEnvironment(
  env: EnvironmentSource = process.env,
): Record<string, string> {
  const publicEnv: Record<string, string> = {};
  for (const name of CLIENT_PUBLIC_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      publicEnv[name] = value;
    }
  }
  return publicEnv;
}
