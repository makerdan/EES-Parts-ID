import {
  assertDatabaseExecutionMode,
  assertProductionDatabaseTarget,
  getClientPublicEnvironment,
  isProductionDatabaseTarget,
} from "@workspace/db/runtime-data-boundary";

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  formatMissingProductionEnvError,
  getEnvironmentContract,
  getMissingProductionEnvVars,
} from "../lib/validateEnv";
import { getScreenViewPrivacyReadiness } from "../lib/screenViewPrivacy";

describe("runtime data boundary", () => {
  const apiRoot = resolve(__dirname, "../..");
  const tsx = resolve(apiRoot, "node_modules/.bin/tsx");
  const entrypoint = resolve(apiRoot, "src/index.ts");
  const preflight = resolve(apiRoot, "scripts/check-production-database.ts");

  const productionEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "test-database",
    CLERK_PUBLISHABLE_KEY: "pk_test_configured",
    CLERK_SECRET_KEY: "sk_test_configured",
    CORS_ALLOWED_ORIGINS: "https://parts.example",
    AI_PROVIDER: "poe",
    POE_API_KEY2: "poe-configured-secret",
    SESSION_SECRET: "session-configured-secret",
    PORT: "31258",
  };

  function runEntrypoint(databaseEnv: string | undefined) {
    const env = { ...process.env, ...productionEnv };
    if (databaseEnv === undefined) {
      delete env.DATABASE_ENV;
    } else {
      env.DATABASE_ENV = databaseEnv;
    }
    return spawnSync(tsx, [entrypoint], {
      cwd: apiRoot,
      encoding: "utf8",
      timeout: 15_000,
      env,
    });
  }

  function runPreflight(databaseEnv: string | undefined) {
    const env = { ...process.env, NODE_ENV: "production" };
    if (databaseEnv === undefined) {
      delete env.DATABASE_ENV;
    } else {
      env.DATABASE_ENV = databaseEnv;
    }
    return spawnSync(tsx, [preflight], {
      cwd: apiRoot,
      encoding: "utf8",
      timeout: 5_000,
      env,
    });
  }

  it("reports missing production names without including secret values", () => {
    const missing = getMissingProductionEnvVars({
      NODE_ENV: "production",
      AI_PROVIDER: "openai",
    });
    const error = formatMissingProductionEnvError(missing);

    expect(missing.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "DATABASE_ENV",
        "DATABASE_URL",
        "CLERK_PUBLISHABLE_KEY",
        "CLERK_SECRET_KEY",
        "CORS_ALLOWED_ORIGINS",
        "AI_INTEGRATIONS_OPENAI_BASE_URL",
        "AI_INTEGRATIONS_OPENAI_API_KEY",
      ]),
    );
    expect(error).toContain("DATABASE_URL");
    expect(error).not.toContain("postgresql://");
    expect(error).not.toContain("sk_live_");
    expect(error).not.toContain("openai-secret");
  });

  it("accepts a complete Replit production runtime contract", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_ENV: "production",
      DATABASE_URL: "test-database",
      CLERK_PUBLISHABLE_KEY: "test-public-key",
      CLERK_SECRET_KEY: "test-secret-key",
      CORS_ALLOWED_ORIGINS: "https://parts.example",
      AI_PROVIDER: "poe",
      POE_API_KEY2: "test-ai-key",
    };

    expect(getMissingProductionEnvVars(env)).toHaveLength(0);
    expect(assertDatabaseExecutionMode("application", env)).toBe("production");
  });

  it.each([undefined, "", "   ", "development", "test", "staging"])(
    "rejects DATABASE_ENV=%p from the production runtime contract",
    (databaseEnv) => {
      const env = {
        NODE_ENV: "production",
        DATABASE_ENV: databaseEnv,
        DATABASE_URL: "test-database",
        CLERK_PUBLISHABLE_KEY: "test-public-key",
        CLERK_SECRET_KEY: "test-secret-key",
        CORS_ALLOWED_ORIGINS: "https://parts.example",
        AI_PROVIDER: "poe",
        POE_API_KEY2: "test-ai-key",
      };

      const invalid = getMissingProductionEnvVars(env);
      const error = formatMissingProductionEnvError(invalid);

      expect(invalid.map((entry) => entry.name)).toEqual(["DATABASE_ENV"]);
      expect(error).toContain("DATABASE_ENV");
      expect(error).toContain("DATABASE_ENV=production");
      if (databaseEnv) {
        expect(error).not.toContain(`DATABASE_ENV=${databaseEnv}`);
      }
    },
  );

  it.each([undefined, "", "   ", "development", "test", "staging"])(
    "exits before database import or listener startup for DATABASE_ENV=%p",
    (databaseEnv) => {
      const result = runEntrypoint(databaseEnv);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      expect(result.error).toBeUndefined();
      expect(output).toContain("DATABASE_ENV");
      expect(output).toContain("DATABASE_ENV=production");
      expect(output).not.toContain("postgresql://configured-secret");
      expect(output).not.toContain("sk_test_configured");
      expect(output).not.toContain("poe-configured-secret");
      expect(output).not.toContain("session-configured-secret");
      expect(output).not.toContain("listening");
    },
    20_000,
  );

  it.each([undefined, "", "development", "test", "staging"])(
    "rejects non-production deployment preflight target %p without echoing it",
    (databaseEnv) => {
      const result = runPreflight(databaseEnv);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      expect(result.error).toBeUndefined();
      expect(output).toContain("production build requires DATABASE_ENV=production");
      if (databaseEnv) {
        expect(output).not.toContain(`DATABASE_ENV=${databaseEnv}`);
      }
      expect(output).not.toContain("postgresql://");
    },
  );

  it("accepts the production target through the shared preflight contract", () => {
    const result = runPreflight("production");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DATABASE_ENV=production confirmed");
  });

  it("shares the production target predicate with startup and preflight callers", () => {
    expect(isProductionDatabaseTarget({ DATABASE_ENV: "production" })).toBe(true);
    expect(isProductionDatabaseTarget({ DATABASE_ENV: "development" })).toBe(false);
    expect(assertProductionDatabaseTarget({ DATABASE_ENV: "production" })).toBe(
      "production",
    );
    expect(() =>
      assertProductionDatabaseTarget({ DATABASE_ENV: "test" }),
    ).toThrow("Production runtime requires DATABASE_ENV=production.");
  });

  it.each([
    {
      NODE_ENV: "development",
      DATABASE_ENV: "development",
    },
    {
      NODE_ENV: "test",
      DATABASE_ENV: "test",
      JEST_WORKER_ID: "1",
    },
  ])("preserves the explicit non-production application mode for %p", (env) => {
    expect(assertDatabaseExecutionMode("application", env)).toBe(
      env.DATABASE_ENV,
    );
  });

  it("returns only explicitly public client configuration", () => {
    const publicEnv = getClientPublicEnvironment({
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "test-public-key",
      EXPO_PUBLIC_API_BASE: "https://parts.example/api",
      DATABASE_URL: "test-database",
      CLERK_SECRET_KEY: "test-secret-key",
      POE_API_KEY2: "test-ai-key",
      DEFAULT_OBJECT_STORAGE_BUCKET_ID: "test-bucket",
    });

    expect(publicEnv).toEqual({
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "test-public-key",
      EXPO_PUBLIC_API_BASE: "https://parts.example/api",
    });
    expect(Object.keys(publicEnv)).not.toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "CLERK_SECRET_KEY",
        "POE_API_KEY2",
        "DEFAULT_OBJECT_STORAGE_BUCKET_ID",
      ]),
    );
  });

  it("keeps server-only and public variables in separate contract lists", () => {
    const contract = getEnvironmentContract();
    expect(contract.serverOnly).toContain("DATABASE_URL");
    expect(contract.serverOnly).toContain("CLERK_SECRET_KEY");
    expect(contract.serverOnly).toContain("VISITOR_PRIVACY_SECRET");
    expect(contract.clientPublic).toContain("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
    expect(contract.clientPublic).not.toContain("DATABASE_URL");
    expect(contract.clientPublic).not.toContain("CLERK_SECRET_KEY");
  });

  it("reports production privacy and CORS readiness using booleans only", () => {
    expect(
      getScreenViewPrivacyReadiness({
        VISITOR_PRIVACY_SECRET: "dedicated-secret",
        SESSION_SECRET: "do-not-return-this",
        CORS_ALLOWED_ORIGINS: "https://parts.example",
      }),
    ).toEqual({
      privacyKeyMaterialConfigured: true,
      productionCorsConfigured: true,
      uniqueVisitorReportingAvailable: true,
    });
  });

  it.each(["test", "seed", "schema-sync"] as const)(
    "rejects %s execution against production",
    (operation) => {
      expect(() =>
        assertDatabaseExecutionMode(operation, {
          DATABASE_ENV: "production",
          NODE_ENV: operation === "test" ? "test" : "development",
          JEST_WORKER_ID: operation === "test" ? "1" : undefined,
        }),
      ).toThrow(/cannot target DATABASE_ENV=production|requires DATABASE_ENV=test/);
    },
  );
});